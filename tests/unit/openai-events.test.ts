import { readFile } from "node:fs/promises";
import type { Stream } from "openai/core/streaming";
import type { AgentSessionEvent } from "openai/resources/beta/agents/agents";
import { expect, it } from "vitest";
import { NativeSessionRun } from "../../src/openai.js";
import { Redactor } from "../../src/redaction.js";
import { RunStore } from "../../src/state.js";
import { temporaryDirectory } from "../temporary.js";

it("consumes native readiness, text, and root completion events", async () => {
  const root = await temporaryDirectory("openai-events-");
  const store = await RunStore.create(root, 60_000);
  const events = [
    {
      type: "agent.session.environment.connected",
      event_id: "evt_1",
      session_id: "sess_1",
      turn_id: null,
      environment: { id: "env_1", status: "connected", type: "self_hosted", error: null },
    },
    {
      type: "agent.session.turn.output_text.done",
      event_id: "evt_2",
      session_id: "sess_1",
      turn_id: "turn_1",
      item_id: "item_1",
      output_index: 0,
      content_index: 0,
      text: "native final",
    },
    {
      type: "agent.session.turn.completed",
      event_id: "evt_3",
      session_id: "sess_1",
      turn_id: "turn_1",
      turn: { subagent_id: null },
      usage: null,
    },
  ] as unknown as AgentSessionEvent[];
  const stream = fakeStream(events);
  const run = new NativeSessionRun(stream, store, new Redactor([]));

  await run.waitForEnvironment();
  await expect(run.waitForCompletion()).resolves.toEqual({
    text: "native final",
    turnId: "turn_1",
  });
  expect(await readFile(store.eventsPath, "utf8")).toContain(
    "agent.session.environment.connected",
  );
});

function fakeStream(events: AgentSessionEvent[]): Stream<AgentSessionEvent> {
  const stream = {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
  return stream as unknown as Stream<AgentSessionEvent>;
}
