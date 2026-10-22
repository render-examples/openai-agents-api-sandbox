# OpenAI coding agent on Render Sandboxes

Build a one-shot coding agent that accepts a prompt, uses OpenAI Agents API for
the Codex agent loop, and executes commands in an ephemeral Render Sandbox.

> Render Sandboxes is early access. The OpenAI Agents API is beta, and
> `codex exec-server` is experimental.

## Quickstart

Requires Node.js 20+, OpenAI Agents API access, and a Render workspace with
Sandboxes enabled.

```bash
npm ci
cp .env.example .env
npm run agent -- \
  "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Optional flags:

```text
--timeout <seconds> Override the 10-minute deadline
--output <path>     Copy /workspace/output files to this local path
```

Run data is written atomically under `runs/<run_id>/`. Cleanup runs after
success, failure, timeout, SIGINT, and SIGTERM.

## Credential and network boundary

`OPENAI_API_KEY` is used only by the local process. The separately restricted
`OPENAI_EXECUTOR_API_KEY` is the only credential sent to Render, where it is
materialized as `CODEX_API_KEY`.

The pinned `@renderinc/sdk` supports an outbound allow-list, which this example
limits to OpenAI's API, the executor WebSocket host, and npm's registry. The
public SDK does not yet expose destination-bound credential brokering. That
temporary creation-time environment injection is isolated in
`src/launch-policy.ts`; replace only that module when the broker API ships.
Agent-run code can read the materialized executor key.

## Source map

- `src/agent.ts`: lifecycle, deadlines, and independent cleanup
- `src/openai.ts`: native Sessions API calls and event handling
- `src/render.ts`: asynchronous Sandbox lifecycle and streamed exec
- `src/outputs.ts`: regular-file download from `/workspace/output`
- `src/state.ts`: private atomic run state and native event log
- `scripts/install-executor.sh`: exact runtime Codex installation

See the complete [tutorial](docs/tutorial.md).
