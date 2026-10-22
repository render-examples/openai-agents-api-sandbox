import { appendFile, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Redactor } from "./redaction.js";

export type CleanupOutcome =
  | "pending"
  | "succeeded"
  | "failed"
  | "not-created"
  | "unknown";

export interface RunState {
  schema_version: 1;
  run_id: string;
  phase: string;
  started_at: string;
  deadline: string;
  sandbox_id?: string;
  openai_session_id?: string;
  openai_environment_id?: string;
  submission_idempotency_key?: string;
  effective_egress_policy?: string[];
  ambiguous_mutation?: string;
  cleanup: {
    provider: CleanupOutcome;
    sandbox: CleanupOutcome;
  };
}

export class RunStore {
  readonly runDirectory: string;
  readonly outputDirectory: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly resultPath: string;
  private state: RunState;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(runDirectory: string, state: RunState) {
    this.runDirectory = runDirectory;
    this.outputDirectory = join(runDirectory, "output");
    this.statePath = join(runDirectory, "run.json");
    this.eventsPath = join(runDirectory, "events.jsonl");
    this.resultPath = join(runDirectory, "result.txt");
    this.state = state;
  }

  static async create(root = "runs", timeoutMs = 600_000): Promise<RunStore> {
    const started = new Date();
    const date = started.toISOString().slice(0, 10);
    const runId = `run_${date}_${randomBytes(4).toString("hex")}`;
    const runDirectory = join(root, runId);
    const state: RunState = {
      schema_version: 1,
      run_id: runId,
      phase: "preflight",
      started_at: started.toISOString(),
      deadline: new Date(started.getTime() + timeoutMs).toISOString(),
      cleanup: { provider: "not-created", sandbox: "not-created" },
    };
    const store = new RunStore(runDirectory, state);
    await mkdir(store.outputDirectory, { recursive: true, mode: 0o700 });
    await store.persist();
    await writeFile(store.eventsPath, "", { mode: 0o600 });
    return store;
  }

  snapshot(): RunState {
    return structuredClone(this.state);
  }

  async update(patch: Partial<RunState>): Promise<void> {
    this.state = {
      ...this.state,
      ...patch,
      cleanup: patch.cleanup
        ? { ...this.state.cleanup, ...patch.cleanup }
        : this.state.cleanup,
    };
    await this.persist();
  }

  async appendEvent(event: unknown, redactor: Redactor): Promise<void> {
    const line = `${JSON.stringify(redactor.value(event))}\n`;
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.eventsPath, line, { encoding: "utf8", mode: 0o600 }),
    );
    await this.writeChain;
  }

  async writeResult(result: string): Promise<void> {
    await writeFile(this.resultPath, result, { encoding: "utf8", mode: 0o600 });
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.statePath);
  }
}
