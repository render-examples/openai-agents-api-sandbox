import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent.js";
import type { Config } from "../../src/config.js";
import type {
  OpenAIAgentsOperations,
  OpenAISessionRun,
} from "../../src/openai.js";
import { Redactor } from "../../src/redaction.js";
import { RenderSandbox, type SandboxApi } from "../../src/render.js";
import type { RunStore } from "../../src/state.js";
import { temporaryDirectory } from "../temporary.js";

describe("provider-native fake lifecycle", () => {
  it("orders readiness, submission, output handoff, and independent cleanup", async () => {
    const order: string[] = [];
    const root = await temporaryDirectory("openai-render-run-");
    const redactor = new Redactor([
      "rnd_render_secret_12345",
      "sk-application-secret-12345",
      "sk-executor-secret-67890",
    ]);
    const api = fakeSandboxApi(order);
    const render = new RenderSandbox("unused", "tea-example", redactor, api);
    const openai = fakeOpenAI(order);
    const config: Config = {
      renderApiKey: "rnd_render_secret_12345",
      renderWorkspaceId: "tea-example",
      openaiApiKey: "sk-application-secret-12345",
      openaiExecutorApiKey: "sk-executor-secret-67890",
      openaiModel: "gpt-6-astra",
      timeoutMs: 60_000,
    };

    const result = await runAgent(
      "write hello.txt",
      config,
      openai,
      render,
      redactor,
      new AbortController().signal,
      root,
    );

    expect(result.result).toBe("done");
    expect(result.outputFiles).toEqual(["hello.txt"]);
    expect(await readFile(join(result.runDirectory, "output", "hello.txt"), "utf8")).toBe(
      "hello\n",
    );
    expect(order.indexOf("open-events")).toBeLessThan(order.indexOf("executor-exec"));
    expect(order.indexOf("wait-environment")).toBeLessThan(order.indexOf("submit"));
    expect(order.indexOf("delete-session")).toBeLessThan(order.indexOf("terminate"));

    const stateText = await readFile(join(result.runDirectory, "run.json"), "utf8");
    expect(stateText).not.toContain(config.openaiApiKey);
    expect(stateText).not.toContain(config.openaiExecutorApiKey);
    const state = JSON.parse(stateText);
    expect(state.phase).toBe("completed");
    expect(state).not.toHaveProperty("error");
    expect(state.cleanup).toEqual({
      provider: "succeeded",
      sandbox: "succeeded",
    });
  });

  it("records a redacted failure reason when the session fails", async () => {
    const order: string[] = [];
    const root = await temporaryDirectory("openai-render-failure-");
    const redactor = new Redactor(["render-key", "application-key", "executor-key"]);
    const openai = fakeOpenAI(order);
    const openSessionEvents = openai.openSessionEvents;
    openai.openSessionEvents = async (sessionId, store) => {
      const run = await openSessionEvents(sessionId, store);
      return {
        ...run,
        async waitForCompletion() {
          throw new Error("Your account is not active (key executor-key)");
        },
      };
    };
    const config: Config = {
      renderApiKey: "render-key",
      renderWorkspaceId: "tea-example",
      openaiApiKey: "application-key",
      openaiExecutorApiKey: "executor-key",
      openaiModel: "gpt-6-astra",
      timeoutMs: 60_000,
    };

    await expect(
      runAgent(
        "write hello.txt",
        config,
        openai,
        new RenderSandbox("unused", "tea-example", redactor, fakeSandboxApi(order)),
        redactor,
        new AbortController().signal,
        root,
      ),
    ).rejects.toThrow("Your account is not active");

    const [runDirectory] = await readdir(root);
    const state = JSON.parse(
      await readFile(join(root, runDirectory!, "run.json"), "utf8"),
    ) as { phase: string; error: string; cleanup: { provider: string; sandbox: string } };
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("Your account is not active");
    expect(state.error).not.toContain("executor-key");
    expect(state.cleanup).toEqual({ provider: "succeeded", sandbox: "succeeded" });
  });

  it("terminates Render when OpenAI cleanup fails and records separate outcomes", async () => {
    const order: string[] = [];
    const root = await temporaryDirectory("openai-render-cleanup-");
    const redactor = new Redactor(["render-key", "application-key", "executor-key"]);
    const render = new RenderSandbox("unused", "tea-example", redactor, fakeSandboxApi(order));
    const openai = fakeOpenAI(order);
    openai.deleteSession = async () => {
      order.push("delete-session-failed");
      throw new Error("provider unavailable");
    };
    const config: Config = {
      renderApiKey: "render-key",
      renderWorkspaceId: "tea-example",
      openaiApiKey: "application-key",
      openaiExecutorApiKey: "executor-key",
      openaiModel: "gpt-6-astra",
      timeoutMs: 60_000,
    };

    await expect(
      runAgent(
        "write hello.txt",
        config,
        openai,
        render,
        redactor,
        new AbortController().signal,
        root,
      ),
    ).rejects.toThrow(/cleanup was incomplete/i);

    expect(order).toContain("terminate");
    const [runDirectory] = await readdir(root);
    const state = JSON.parse(
      await readFile(join(root, runDirectory!, "run.json"), "utf8"),
    ) as { cleanup: { provider: string; sandbox: string } };
    expect(state.cleanup).toEqual({ provider: "failed", sandbox: "succeeded" });
  });

  it("fails closed and records an ambiguous non-idempotent creation", async () => {
    const order: string[] = [];
    const root = await temporaryDirectory("openai-render-ambiguous-");
    const redactor = new Redactor(["render-key", "application-key", "executor-key"]);
    const openai = fakeOpenAI(order);
    openai.createSession = async () => {
      order.push("create-session-ambiguous");
      throw new Error("connection reset");
    };
    const config: Config = {
      renderApiKey: "render-key",
      renderWorkspaceId: "tea-example",
      openaiApiKey: "application-key",
      openaiExecutorApiKey: "executor-key",
      openaiModel: "gpt-6-astra",
      timeoutMs: 60_000,
    };

    await expect(
      runAgent(
        "do not retry this",
        config,
        openai,
        new RenderSandbox("unused", "tea-example", redactor, fakeSandboxApi(order)),
        redactor,
        new AbortController().signal,
        root,
      ),
    ).rejects.toThrow("connection reset");

    expect(order).toEqual(["preflight", "create-session-ambiguous"]);
    const [runDirectory] = await readdir(root);
    const state = JSON.parse(
      await readFile(join(root, runDirectory!, "run.json"), "utf8"),
    ) as { ambiguous_mutation: string; cleanup: { provider: string; sandbox: string } };
    expect(state.ambiguous_mutation).toContain("Reconcile before retrying");
    expect(state.cleanup).toEqual({ provider: "unknown", sandbox: "not-created" });
  });
});

describe("interrupts during creation", () => {
  it("records and terminates a sandbox whose create completes after SIGINT", async () => {
    const order: string[] = [];
    const root = await temporaryDirectory("openai-render-interrupt-");
    const redactor = new Redactor(["render-key", "application-key", "executor-key"]);
    const api = fakeSandboxApi(order);
    const controller = new AbortController();
    const create = api.create;
    api.create = async (input) => {
      controller.abort(new Error("Received SIGINT"));
      await sleep(20);
      return create(input);
    };
    const config: Config = {
      renderApiKey: "render-key",
      renderWorkspaceId: "tea-example",
      openaiApiKey: "application-key",
      openaiExecutorApiKey: "executor-key",
      openaiModel: "gpt-6-astra",
      timeoutMs: 60_000,
    };

    await expect(
      runAgent(
        "write hello.txt",
        config,
        fakeOpenAI(order),
        new RenderSandbox("unused", "tea-example", redactor, api),
        redactor,
        controller.signal,
        root,
      ),
    ).rejects.toThrow("Received SIGINT");

    expect(order).toContain("terminate");
    const [runDirectory] = await readdir(root);
    const state = JSON.parse(
      await readFile(join(root, runDirectory!, "run.json"), "utf8"),
    ) as { sandbox_id?: string; cleanup: { provider: string; sandbox: string } };
    expect(state.sandbox_id).toBe("sbx-123");
    expect(state.cleanup).toEqual({ provider: "succeeded", sandbox: "succeeded" });
  });
});

function fakeOpenAI(order: string[]): OpenAIAgentsOperations {
  const sessionRun: OpenAISessionRun = {
    async waitForEnvironment() {
      order.push("wait-environment");
    },
    async waitForCompletion() {
      order.push("wait-completion");
      return { text: "done", turnId: "turn_123" };
    },
    close() {
      order.push("close-events");
    },
  };
  return {
    async preflight() {
      order.push("preflight");
    },
    async createSession() {
      order.push("create-session");
      return {
        sessionId: "sess_123",
        environmentId: "env_123",
        remoteUrl: "https://example.invalid/remote",
      };
    },
    async openSessionEvents(_sessionId: string, _store: RunStore) {
      order.push("open-events");
      return sessionRun;
    },
    async submitPrompt() {
      order.push("submit");
    },
    async cancelActiveTurn() {
      order.push("cancel");
    },
    async deleteSession() {
      order.push("delete-session");
    },
  };
}

function fakeSandboxApi(order: string[]): SandboxApi {
  return {
    async create(input) {
      order.push("create-sandbox");
      expect(input?.env).toHaveProperty("CODEX_API_KEY");
      expect(input?.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(input?.networkPolicy).toMatchObject({ type: "allow-list" });
      return { id: "sbx-123", status: "creating" };
    },
    async get() {
      order.push("poll-sandbox");
      return { id: "sbx-123", status: "running" };
    },
    async terminate() {
      order.push("terminate");
    },
    async upload() {
      order.push("upload");
    },
    async download() {
      order.push("download");
      return {
        data: Buffer.from("hello\n"),
        size: 6,
        contentType: "text/plain",
      };
    },
    async exec(_id, command, _ownerId, signal) {
      if (command.includes("install-executor.sh")) {
        order.push("install-exec");
        return finiteEvents("codex-cli 0.163.0\n");
      }
      if (command.includes("exec codex exec-server")) {
        order.push("executor-exec");
        return executorEvents(signal!);
      }
      if (command.includes("find -P /workspace/output")) {
        order.push("list-exec");
        return finiteEvents("hello.txt\0");
      }
      throw new Error(`Unexpected fake command: ${command}`);
    },
  };
}

async function* finiteEvents(stdout: string) {
  yield { type: "output" as const, stream: "stdout" as const, data: stdout };
  yield { type: "exit" as const, exit_code: 0 };
}

async function* executorEvents(signal: AbortSignal) {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  yield { type: "exit" as const, exit_code: 0 };
}
