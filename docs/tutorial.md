# Build a coding agent with OpenAI Agents API and Render Sandboxes

In this tutorial, you build a coding agent that accepts a prompt, streams its
work, and returns its response and output files.

OpenAI runs the Codex agent loop through the Agents API. `codex exec-server`
runs the coding agent's commands and file edits in an isolated Render Sandbox
in your Render workspace.

You will learn how to:

- connect an OpenAI Agents API session to a Render Sandbox;
- send a coding task as a prompt and follow native session events;
- copy files the agent writes to `/workspace/output`; and
- clean up the session and sandbox.

Time to complete: about 20 minutes after access is enabled.

## Prerequisites

You need:

- A Render workspace with Render Sandboxes enabled
- A Render API key and workspace ID
- OpenAI Agents API access
- An OpenAI application API key with the permissions required for Agents API
  sessions
- A separate OpenAI environment key restricted to connecting self-hosted
  environments
- Node.js and Git

Render Sandboxes is early access. The Agents API is beta, and
`codex exec-server` is experimental. This template pins the exact Codex version
that its install script verifies.

## Get the template

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/openai-agents-api-sandbox
cd openai-agents-api-sandbox
npm ci
```

## Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Set:

```text
RENDER_API_KEY=
RENDER_WORKSPACE_ID=
OPENAI_API_KEY=
OPENAI_EXECUTOR_API_KEY=
```

`OPENAI_API_KEY` stays with the application. Only the restricted executor
credential enters the sandbox, where `codex exec-server` reads it as
`CODEX_API_KEY`.

## Run the coding agent

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Expected summary:

```text
preflight     passed
provision     sbx-...
environment   connected
prompt        submitted
agent         created and tested the server
result        task completed
outputs       copied 1 file to runs/run_.../output
cleanup       OpenAI session succeeded; sandbox succeeded
```

## What happened

The template:

1. Creates a self-hosted Agents API session.
2. Atomically records the session and environment IDs and retains the remote
   URL in memory for the executor connection.
3. Creates a Render Sandbox with the required egress policy.
4. Opens the OpenAI session event stream.
5. Starts `codex exec-server` in the sandbox with the restricted environment
   credential.
6. Waits for the environment-connected event and submits your prompt.
7. Streams the final result and copies files from `/workspace/output`.
8. Deletes the OpenAI session and terminates the Render Sandbox.

The implementation uses OpenAI's native session and event types directly. It
does not use a cross-provider adapter.

## How the template is organized

- [`src/agent.ts`](../src/agent.ts) owns the one-shot lifecycle and cleanup.
- [`src/openai.ts`](../src/openai.ts) uses native OpenAI Sessions and events.
- [`src/render.ts`](../src/render.ts) polls asynchronous creation and drains
  streamed `bash -c` exec events.
- [`src/launch-policy.ts`](../src/launch-policy.ts) contains the egress and
  credential-delivery compatibility seam.
- [`src/outputs.ts`](../src/outputs.ts) lists and downloads regular files from
  `/workspace/output`.

## What you built

You built a one-shot Codex runner that accepts a prompt, connects an OpenAI
Agents API session to a Render Sandbox, streams the native session events, and
copies optional output files back to your machine.

## Security

The OpenAI application key never enters the sandbox. Code the agent runs can
read any credential materialized in the same sandbox, so the executor
credential must have only the permissions required to connect that environment.

The Render egress policy allows only `api.openai.com`,
`codex-cloud-environments.chatgpt.com`, and `registry.npmjs.org`. npm access
remains enabled for this short-lived example because the public SDK does not
provide stage-scoped policy updates. Tool inputs and outputs pass through
OpenAI because OpenAI hosts the agent loop.

The current public Render SDK does not expose destination-bound credential
brokering. The restricted executor key is therefore materialized in the
sandbox at creation. This compatibility behavior is isolated in
`src/launch-policy.ts`; it does not fabricate future SDK fields.

Do not use production credentials or sensitive source code with this example
until you have reviewed its policy and credential settings.

## Customize the template

You can change:

- prompt handling in `src/agent.ts`;
- the executor version and installation in `scripts/install-executor.sh`;
- the sandbox lifetime and egress policy in `src/render.ts`; and
- output collection in `src/outputs.ts`.

The pinned Codex `0.163.0` release was checked for the
`codex exec-server --remote ... --environment-id ...` command. At the time this
template was built, OpenAI's documented npm `alpha` dist-tag resolved to an
unpublished umbrella version, so the runnable exact stable release is used
instead of an unresolvable tag.

## Clean up

Cleanup runs automatically on success, failure, timeout, SIGINT, and SIGTERM.
If cleanup is incomplete, the command prints the OpenAI session ID, Render
Sandbox ID, and exact manual cleanup commands.

Deleting the OpenAI session and terminating the Render Sandbox are separate
operations.

## Troubleshooting

### The session cannot be created

Confirm Agents API access, API-key permissions, and the beta API version pinned
by the template.

### The environment never connects

Check the executor stream, restricted environment key, environment ID, remote
URL, and egress policy.

### The task never starts

Open the session event log and confirm the environment reached its connected
state before input was submitted.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and the final result. Output files are
optional; prompts that need files should tell the agent to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands printed by the agent runner. Clean up the OpenAI session and Render
Sandbox independently.

## Next steps

- [OpenAI self-hosted sandbox documentation](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Template source](https://github.com/render-examples/openai-agents-api-sandbox)
