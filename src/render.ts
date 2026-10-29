import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";
import type {
  SandboxCreateInput,
  SandboxDownload,
  SandboxExecEvent,
} from "@renderinc/sdk/experimental";
import type { Redactor } from "./redaction.js";

export interface SandboxApi {
  create(input?: SandboxCreateInput): Promise<{ id: string; status: string }>;
  get(id: string): Promise<{ id: string; status: string }>;
  terminate(id: string): Promise<void>;
  upload(id: string, path: string, data: string | Buffer): Promise<void>;
  download(id: string, path: string, ownerId?: `tea-${string}`, signal?: AbortSignal): Promise<SandboxDownload>;
  exec(
    id: string,
    command: string,
    ownerId?: `tea-${string}`,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<SandboxExecEvent>>;
}

export interface ExecutorHandle {
  done: Promise<number>;
  stop(): void;
}

export class RenderSandbox {
  private readonly api: SandboxApi;

  constructor(
    token: string,
    ownerId: `tea-${string}`,
    private readonly redactor: Redactor,
    api?: SandboxApi,
  ) {
    this.api = api ?? new Render({ token, ownerId }).experimental.sandboxes;
  }

  async create(input: SandboxCreateInput): Promise<string> {
    return (await this.api.create(input)).id;
  }

  async download(id: string, path: string, signal: AbortSignal): Promise<Buffer> {
    return (await this.api.download(id, path, undefined, signal)).data;
  }

  async waitUntilRunning(id: string, deadlineMs: number, signal: AbortSignal): Promise<void> {
    let delayMs = 750;
    while (Date.now() < deadlineMs) {
      signal.throwIfAborted();
      const sandbox = await this.api.get(id);
      if (sandbox.status === "running") return;
      if (sandbox.status === "errored" || sandbox.status === "terminated") {
        throw new Error(`Render Sandbox ${id} entered ${sandbox.status}`);
      }
      await sleep(delayMs, undefined, { signal });
      delayMs = Math.min(Math.round(delayMs * 1.4), 3_000);
    }
    throw new Error(`Timed out waiting for Render Sandbox ${id} to become running`);
  }

  async installExecutor(
    id: string,
    script: string,
    signal: AbortSignal,
    logPath: string,
  ): Promise<void> {
    await this.api.upload(id, "/tmp/install-executor.sh", script);
    const result = await this.execBuffered(
      id,
      "chmod 0700 /tmp/install-executor.sh && /bin/bash /tmp/install-executor.sh",
      signal,
      logPath,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Executor installation failed with exit code ${result.exitCode}`);
    }
  }

  async startExecutor(
    id: string,
    remoteUrl: string,
    environmentId: string,
    signal: AbortSignal,
    logPath: string,
  ): Promise<ExecutorHandle> {
    const localAbort = new AbortController();
    const combined = AbortSignal.any([signal, localAbort.signal]);
    const command = [
      "exec codex exec-server",
      `--remote ${shellQuote(remoteUrl)}`,
      `--environment-id ${shellQuote(environmentId)}`,
    ].join(" ");
    const events = await this.api.exec(id, command, undefined, combined);
    const done = this.drain(events, logPath);
    return { done, stop: () => localAbort.abort() };
  }

  async execBuffered(
    id: string,
    command: string,
    signal: AbortSignal,
    logPath?: string,
    maxBytes = 1_048_576,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const events = await this.api.exec(id, command, undefined, signal);
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const log = new LineLabeler((stream) => `[${stream}] `);
    for await (const event of events) {
      if (event.type === "output") {
        const safe = this.redactor.text(event.data);
        if (logPath) await appendFile(logPath, log.format(event.stream, safe), { mode: 0o600 });
        if (event.stream === "stdout" && Buffer.byteLength(stdout) < maxBytes) stdout += safe;
        if (event.stream === "stderr" && Buffer.byteLength(stderr) < maxBytes) stderr += safe;
      } else {
        exitCode = event.exit_code;
      }
    }
    if (logPath) await appendFile(logPath, log.end(), { mode: 0o600 });
    if (exitCode === undefined) throw new Error("Render exec stream ended without an exit event");
    return {
      stdout: truncate(stdout, maxBytes),
      stderr: truncate(stderr, maxBytes),
      exitCode,
    };
  }

  async terminate(id: string): Promise<void> {
    await this.api.terminate(id);
  }

  private async drain(events: AsyncIterable<SandboxExecEvent>, logPath: string): Promise<number> {
    const log = new LineLabeler((stream) => `[${stream}] `);
    const terminal = new LineLabeler((stream) => `[executor:${stream}] `);
    for await (const event of events) {
      if (event.type === "output") {
        const safe = this.redactor.text(event.data);
        await appendFile(logPath, log.format(event.stream, safe), { mode: 0o600 });
        process.stderr.write(terminal.format(event.stream, safe));
      } else {
        await appendFile(logPath, `${log.end()}[exit] ${event.exit_code}\n`, { mode: 0o600 });
        process.stderr.write(terminal.end());
        return event.exit_code;
      }
    }
    throw new Error("Executor stream ended without an exit event");
  }
}

/**
 * Labels each line of interleaved stdout/stderr output. Exec events arrive in
 * arbitrary chunks, so a line can span several events.
 */
export class LineLabeler {
  private lastStream: string | undefined;
  private atLineStart = true;

  constructor(private readonly label: (stream: string) => string) {}

  format(stream: string, chunk: string): string {
    if (!chunk) return "";
    let formatted = "";
    if (stream !== this.lastStream && !this.atLineStart) {
      formatted += "\n";
      this.atLineStart = true;
    }
    this.lastStream = stream;
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (this.atLineStart) formatted += this.label(stream);
      formatted += piece;
      this.atLineStart = piece.endsWith("\n");
    }
    return formatted;
  }

  /** Terminates a trailing partial line. */
  end(): string {
    if (this.atLineStart) return "";
    this.atLineStart = true;
    return "\n";
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n[output truncated]\n`;
}
