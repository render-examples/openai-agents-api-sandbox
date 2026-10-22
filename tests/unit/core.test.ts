import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/cli.js";
import { loadConfig } from "../../src/config.js";
import { Redactor } from "../../src/redaction.js";
import { RunStore } from "../../src/state.js";

describe("configuration", () => {
  const env = {
    RENDER_API_KEY: "rnd_render_secret_12345",
    RENDER_WORKSPACE_ID: "tea-example",
    OPENAI_API_KEY: "sk-application-secret-12345",
    OPENAI_EXECUTOR_API_KEY: "sk-executor-secret-67890",
  };

  it("validates and separates credentials", () => {
    const config = loadConfig(env);
    expect(config.timeoutMs).toBe(600_000);
    expect(config.openaiExecutorApiKey).not.toBe(config.openaiApiKey);
  });

  it("rejects a shared application and executor key", () => {
    expect(() =>
      loadConfig({ ...env, OPENAI_EXECUTOR_API_KEY: env.OPENAI_API_KEY }),
    ).toThrow(/separate credentials/);
  });

  it("parses the stable command shape", () => {
    expect(
      parseArguments(["make a file", "--timeout", "90", "--output", "./artifacts"]),
    ).toEqual({
      prompt: "make a file",
      timeoutSeconds: 90,
      outputDirectory: "./artifacts",
    });
  });
});

describe("state and redaction", () => {
  it("atomically persists private state and redacted events", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-render-state-"));
    const store = await RunStore.create(root, 60_000);
    const redactor = new Redactor(["sk-known-secret-123456"]);
    await store.update({ openai_session_id: "sess_123", phase: "running" });
    await store.appendEvent(
      { type: "test", token: "sk-known-secret-123456" },
      redactor,
    );

    const state = JSON.parse(await readFile(store.statePath, "utf8")) as {
      openai_session_id: string;
    };
    expect(state.openai_session_id).toBe("sess_123");
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600);
    const events = await readFile(store.eventsPath, "utf8");
    expect(events).toContain("[REDACTED]");
    expect(events).not.toContain("sk-known-secret-123456");
  });

  it("refuses an artifact containing a known secret", () => {
    const redactor = new Redactor(["executor-secret-value"]);
    expect(() =>
      redactor.assertSafeBytes(Buffer.from("oops executor-secret-value"), "output.txt"),
    ).toThrow(/contains a configured secret/);
  });
});
