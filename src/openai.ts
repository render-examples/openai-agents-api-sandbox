import OpenAI from "openai";
import type {
  AgentSession,
  AgentSessionEvent,
} from "openai/resources/beta/agents/agents";
import type { Stream } from "openai/core/streaming";
import type { Redactor } from "./redaction.js";
import type { RunStore } from "./state.js";

export interface SessionConnection {
  sessionId: string;
  environmentId: string;
  remoteUrl: string;
}

export interface SessionResult {
  text: string;
  turnId: string;
}

export interface OpenAISessionRun {
  waitForEnvironment(): Promise<void>;
  waitForCompletion(): Promise<SessionResult>;
  close(): void;
}

export interface OpenAIAgentsOperations {
  preflight(signal: AbortSignal): Promise<void>;
  createSession(model: string): Promise<SessionConnection>;
  openSessionEvents(sessionId: string, store: RunStore): Promise<OpenAISessionRun>;
  submitPrompt(sessionId: string, prompt: string, idempotencyKey: string): Promise<void>;
  cancelActiveTurn(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export class OpenAIAgents implements OpenAIAgentsOperations {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly redactor: Redactor) {
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  /** Confirms Agents API access before any Render resource is created. */
  async preflight(signal: AbortSignal): Promise<void> {
    await this.client.beta.agents.sessions.list({ limit: 1 }, { signal, maxRetries: 2 });
  }

  /**
   * Not abortable: an abandoned request could create a session whose ID is
   * never recorded and therefore never deleted.
   */
  async createSession(model: string): Promise<SessionConnection> {
    const session = await this.client.beta.agents.sessions.create(
      {
        agent: {
          model,
          instructions:
            "You are a coding assistant. Work only in /workspace, put requested deliverables in /workspace/output, and verify your work before finishing.",
        },
        environment: {
          type: "self_hosted",
          workspace_directory: "/workspace",
        },
      },
      { maxRetries: 0 },
    );
    return sessionConnection(session);
  }

  async openSessionEvents(sessionId: string, store: RunStore): Promise<OpenAISessionRun> {
    const stream = await this.client.beta.agents.sessions.events.stream(sessionId, {
      maxRetries: 0,
    });
    return new NativeSessionRun(stream, store, this.redactor);
  }

  async submitPrompt(
    sessionId: string,
    prompt: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.client.beta.agents.sessions.events.create(
      sessionId,
      {
        "Idempotency-Key": idempotencyKey,
        events: [
          {
            type: "agent.session.input.message",
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: prompt }],
              },
            ],
          },
        ],
      },
      { maxRetries: 2 },
    );
  }

  async cancelActiveTurn(sessionId: string): Promise<void> {
    await this.client.beta.agents.sessions.events.create(
      sessionId,
      { events: [{ type: "agent.session.input.cancel" }] },
      { maxRetries: 0, timeout: 15_000 },
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.beta.agents.sessions.delete(sessionId, {
      maxRetries: 0,
      timeout: 30_000,
    });
  }
}

export class NativeSessionRun implements OpenAISessionRun {
  private readonly connected = deferred<void>();
  private readonly completed = deferred<SessionResult>();
  private readonly textParts = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly stream: Stream<AgentSessionEvent>,
    private readonly store: RunStore,
    private readonly redactor: Redactor,
  ) {
    void this.pump();
  }

  waitForEnvironment(): Promise<void> {
    return this.connected.promise;
  }

  waitForCompletion(): Promise<SessionResult> {
    return this.completed.promise;
  }

  close(): void {
    this.closed = true;
    this.stream.controller.abort();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.stream) {
        await this.store.appendEvent(event, this.redactor);
        this.handle(event);
      }
      if (!this.closed) throw new Error("OpenAI event stream closed before the root turn ended");
    } catch (error) {
      if (!this.closed) {
        this.connected.reject(error);
        this.completed.reject(error);
      }
    }
  }

  private handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent.session.environment.connected":
        console.log("environment   connected");
        this.connected.resolve();
        break;
      case "agent.session.environment.failed":
        this.fail(new Error(`OpenAI environment failed: ${event.environment.error?.message ?? "unknown error"}`));
        break;
      case "agent.session.failed":
        this.fail(new Error(`OpenAI session failed: ${event.session.error ?? "unknown error"}`));
        break;
      case "error":
        this.fail(new Error(`OpenAI event error: ${event.error.message}`));
        break;
      case "agent.session.turn.item.done":
        console.log(`progress      ${event.item.type}`);
        break;
      case "agent.session.turn.output_text.done":
        this.textParts.set(partKey(event), event.text);
        console.log(`agent         ${this.redactor.text(event.text).replaceAll("\n", "\n              ")}`);
        break;
      case "agent.session.turn.failed":
        if (event.turn.subagent_id === null) {
          this.fail(
            new Error(
              `OpenAI root turn failed: ${event.turn.error?.message ?? "unknown error"}`,
            ),
          );
        }
        break;
      case "agent.session.turn.cancelled":
        if (event.turn.subagent_id === null) this.fail(new Error("OpenAI root turn was cancelled"));
        break;
      case "agent.session.turn.completed":
        if (event.turn.subagent_id === null) {
          const text = [...this.textParts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, value]) => value)
            .join("\n");
          this.completed.resolve({ text, turnId: event.turn_id });
        }
        break;
    }
  }

  private fail(error: Error): void {
    this.connected.reject(error);
    this.completed.reject(error);
  }
}

function sessionConnection(session: AgentSession): SessionConnection {
  if (session.environment.type !== "self_hosted") {
    throw new Error(`Expected self_hosted environment, received ${session.environment.type}`);
  }
  return {
    sessionId: session.id,
    environmentId: session.environment.id,
    remoteUrl: session.environment.remote_url,
  };
}

function partKey(event: {
  output_index: number;
  content_index: number;
  item_id: string;
}): string {
  return `${String(event.output_index).padStart(8, "0")}:${String(event.content_index).padStart(8, "0")}:${event.item_id}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * True when a failed mutation may still have taken effect on the server. OpenAI
 * errors expose `status`; Render SDK errors expose `statusCode`.
 */
export function isAmbiguousMutationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const code =
    typeof status === "number" ? status : typeof statusCode === "number" ? statusCode : undefined;
  return code === undefined || code === 408 || code === 409 || code === 429 || code >= 500;
}
