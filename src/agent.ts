import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import {
  buildSandboxLaunchInput,
  EGRESS_DESTINATIONS,
} from "./launch-policy.js";
import {
  isAmbiguousMutationError,
  type OpenAIAgentsOperations,
  type OpenAISessionRun,
} from "./openai.js";
import { copyWorkspaceOutputs } from "./outputs.js";
import type { Redactor } from "./redaction.js";
import type { ExecutorHandle, RenderSandbox } from "./render.js";
import { RunStore } from "./state.js";

export interface AgentRunResult {
  runDirectory: string;
  result: string;
  outputFiles: string[];
}

export async function runAgent(
  prompt: string,
  config: Config,
  openai: OpenAIAgentsOperations,
  render: RenderSandbox,
  redactor: Redactor,
  signal: AbortSignal,
  runsRoot = "runs",
): Promise<AgentRunResult> {
  const store = await RunStore.create(runsRoot, config.timeoutMs);
  const deadlineMs = Date.parse(store.snapshot().deadline);
  const executorLog = resolve(store.runDirectory, "executor.log");
  let sessionId: string | undefined;
  let sandboxId: string | undefined;
  let sessionRun: OpenAISessionRun | undefined;
  let executor: ExecutorHandle | undefined;
  let submitted = false;
  let terminal = false;
  let runResult: AgentRunResult | undefined;
  let primaryError: unknown;
  const cleanupErrors: Error[] = [];

  console.log("provider      openai");

  try {
    await openai.preflight(signal);
    console.log("preflight     passed");

    await store.update({ phase: "creating_openai_session" });
    let connection;
    try {
      connection = await openai.createSession(config.openaiModel);
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        await store.update({
          phase: "failed",
          ambiguous_mutation:
            'OpenAI session creation may have succeeded without returning an ID. Reconcile before retrying: curl "https://api.openai.com/v1/agents/sessions?limit=100" -H "Authorization: Bearer $OPENAI_API_KEY" -H "OpenAI-Beta: agents=v1"',
          cleanup: { provider: "unknown", sandbox: "not-created" },
        });
      }
      throw error;
    }

    sessionId = connection.sessionId;
    await store.update({
      phase: "openai_session_created",
      openai_session_id: sessionId,
      openai_environment_id: connection.environmentId,
      cleanup: { provider: "pending", sandbox: "not-created" },
    });
    signal.throwIfAborted();

    await store.update({
      phase: "creating_sandbox",
      effective_egress_policy: [...EGRESS_DESTINATIONS],
    });
    try {
      sandboxId = await render.create(
        buildSandboxLaunchInput(
          config.openaiExecutorApiKey,
          Math.min(86_400, Math.ceil(config.timeoutMs / 1_000) + 120),
        ),
      );
    } catch (error) {
      if (isAmbiguousMutationError(error)) {
        await store.update({
          phase: "failed",
          ambiguous_mutation:
            'Render Sandbox creation may have succeeded without returning an ID. Reconcile before retrying: RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render sandboxes list',
          cleanup: { provider: "pending", sandbox: "unknown" },
        });
      }
      throw error;
    }

    await store.update({
      phase: "sandbox_created",
      sandbox_id: sandboxId,
      cleanup: { provider: "pending", sandbox: "pending" },
    });
    console.log(`provision     ${sandboxId}`);
    await render.waitUntilRunning(sandboxId, deadlineMs, signal);

    const installScript = await readFile(
      new URL("../scripts/install-executor.sh", import.meta.url),
      "utf8",
    );
    await store.update({ phase: "installing_executor" });
    await raceAbort(
      render.installExecutor(sandboxId, installScript, signal, executorLog),
      signal,
    );

    // Open and begin consuming the native stream before the executor connects.
    sessionRun = await raceAbort(openai.openSessionEvents(sessionId, store), signal);
    executor = await raceAbort(
      render.startExecutor(
        sandboxId,
        connection.remoteUrl,
        connection.environmentId,
        signal,
        executorLog,
      ),
      signal,
    );
    const executorExited = executorExitFailure(executor);
    void executorExited.catch(() => undefined);

    await store.update({ phase: "waiting_for_environment" });
    await Promise.race([
      raceAbort(sessionRun.waitForEnvironment(), signal),
      executorExited,
    ]);

    const submissionKey = randomUUID();
    await store.update({
      phase: "submitting_prompt",
      submission_idempotency_key: submissionKey,
    });
    await raceAbort(openai.submitPrompt(sessionId, prompt, submissionKey), signal);
    submitted = true;
    await store.update({ phase: "running" });
    console.log("prompt        submitted");

    const result = await Promise.race([
      raceAbort(sessionRun.waitForCompletion(), signal),
      executorExited,
    ]);
    terminal = true;
    const safeResult = redactor.text(result.text || "(The agent returned no text.)");
    await store.writeResult(safeResult);
    console.log("result        task completed");

    await store.update({ phase: "copying_outputs" });
    const localOutput = config.outputDirectory
      ? resolve(config.outputDirectory)
      : store.outputDirectory;
    const outputFiles = await raceAbort(
      copyWorkspaceOutputs(
        render,
        sandboxId,
        localOutput,
        redactor,
        signal,
      ),
      signal,
    );
    console.log(
      `outputs       copied ${outputFiles.length} file${outputFiles.length === 1 ? "" : "s"} to ${localOutput}`,
    );
    await store.update({ phase: "cleanup" });
    runResult = { runDirectory: store.runDirectory, result: safeResult, outputFiles };
  } catch (error) {
    primaryError = signal.aborted ? signal.reason : error;
    await store.update({ phase: "failed" });
  } finally {
    sessionRun?.close();
    executor?.stop();

    if (sessionId) {
      if (submitted && !terminal) {
        try {
          await openai.cancelActiveTurn(sessionId);
        } catch {
          // Deletion is still attempted and reported independently.
        }
      }
      try {
        await withTimeout(openai.deleteSession(sessionId), 30_000, "OpenAI cleanup");
        await store.update({ cleanup: { provider: "succeeded", sandbox: store.snapshot().cleanup.sandbox } });
      } catch (error) {
        cleanupErrors.push(asError("OpenAI session cleanup failed", error));
        await store.update({ cleanup: { provider: "failed", sandbox: store.snapshot().cleanup.sandbox } });
      }
    }

    if (sandboxId) {
      try {
        await withTimeout(render.terminate(sandboxId), 30_000, "Render cleanup");
        await store.update({ cleanup: { provider: store.snapshot().cleanup.provider, sandbox: "succeeded" } });
      } catch (error) {
        cleanupErrors.push(asError("Render Sandbox cleanup failed", error));
        await store.update({ cleanup: { provider: store.snapshot().cleanup.provider, sandbox: "failed" } });
      }
    }
  }

  const cleanup = store.snapshot().cleanup;
  const describe = (outcome: string, done: string) => (outcome === "succeeded" ? done : outcome);
  console.log(
    `cleanup       session ${describe(cleanup.provider, "deleted")}; sandbox ${describe(cleanup.sandbox, "terminated")}`,
  );
  const ambiguousMutation = store.snapshot().ambiguous_mutation;
  if (ambiguousMutation) console.error(`reconcile     ${ambiguousMutation}`);
  if (cleanupErrors.length > 0) {
    printManualCleanup(sessionId, sandboxId, cleanup);
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Run cleanup was incomplete",
    );
  }
  if (primaryError) throw primaryError;
  if (!runResult) throw new Error("Agent run ended without a result");
  return runResult;
}

function executorExitFailure(executor: ExecutorHandle): Promise<never> {
  return executor.done.then((exitCode) => {
    throw new Error(`codex exec-server exited before the run completed (code ${exitCode})`);
  });
}

/** Rejects with the abort reason for operations that do not accept a signal. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function asError(prefix: string, error: unknown): Error {
  return new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

function printManualCleanup(
  sessionId: string | undefined,
  sandboxId: string | undefined,
  cleanup: { provider: string; sandbox: string },
): void {
  console.error("Manual cleanup required:");
  if (sessionId && cleanup.provider === "failed") {
    console.error(
      `curl -X DELETE https://api.openai.com/v1/agents/sessions/${sessionId} -H "Authorization: Bearer $OPENAI_API_KEY" -H "OpenAI-Beta: agents=v1"`,
    );
  }
  if (sandboxId && cleanup.sandbox === "failed") {
    console.error(
      `RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render sandboxes stop ${sandboxId} --confirm`,
    );
  }
}
