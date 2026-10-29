import { getEventListeners } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { raceAbort } from "../../src/agent.js";
import { parseArguments } from "../../src/cli.js";
import { loadConfig } from "../../src/config.js";
import { isAmbiguousMutationError } from "../../src/openai.js";
import { Redactor } from "../../src/redaction.js";
import { LineLabeler } from "../../src/render.js";
import { RunStore } from "../../src/state.js";
import { temporaryDirectory } from "../temporary.js";

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

  it("joins unquoted prompt words like the other templates", () => {
    expect(parseArguments(["make", "a", "file"]).prompt).toBe("make a file");
  });

  it.each(["12.5", "0", "-1", "abc"])("rejects --timeout %s", (value) => {
    expect(() => parseArguments(["prompt", "--timeout", value])).toThrow("positive integer");
  });
});

describe("lifecycle helpers", () => {
  it("raceAbort removes its abort listener once the operation settles", async () => {
    const controller = new AbortController();
    for (let index = 0; index < 20; index += 1) {
      await raceAbort(Promise.resolve(index), controller.signal);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("treats only retryable or unknown outcomes as ambiguous", () => {
    expect(isAmbiguousMutationError(new TypeError("fetch failed"))).toBe(true);
    expect(isAmbiguousMutationError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isAmbiguousMutationError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(isAmbiguousMutationError(Object.assign(new Error("x"), { statusCode: 422 }))).toBe(false);
    expect(isAmbiguousMutationError(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(true);
  });
});

describe("state and redaction", () => {
  it("atomically persists private state and redacted events", async () => {
    const root = await temporaryDirectory("openai-render-state-");
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

  it("labels each line of chunked, interleaved executor output once", () => {
    const labeler = new LineLabeler((stream) => `[${stream}] `);
    const log = [
      labeler.format("stderr", "Error: "),
      labeler.format("stderr", "authentication failed"),
      labeler.format("stderr", " (403)\nsecond"),
      labeler.format("stdout", "out\n"),
      labeler.format("stderr", "tail"),
      labeler.end(),
    ].join("");
    expect(log).toBe(
      "[stderr] Error: authentication failed (403)\n" +
        "[stderr] second\n" +
        "[stdout] out\n" +
        "[stderr] tail\n",
    );
  });

  it("refuses an artifact containing a known secret", () => {
    const redactor = new Redactor(["executor-secret-value"]);
    expect(() =>
      redactor.assertSafeBytes(Buffer.from("oops executor-secret-value"), "output.txt"),
    ).toThrow(/contains a configured secret/);
  });
});
