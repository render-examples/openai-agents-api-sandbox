# Build a coding agent with OpenAI Agents API and Render Sandboxes

> **Note:** Render Sandboxes is in early access. The OpenAI Agents API is in
> beta, and `codex exec-server` is experimental.

The [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
runs the Codex agent loop on OpenAI's infrastructure and can send its commands
and file edits to a self-hosted environment. Render Sandboxes gives that
environment an isolated, ephemeral Linux machine in your Render workspace, with
outbound traffic denied by default.

In this tutorial, you build a coding agent that accepts a prompt, runs Codex's
commands and file edits through `codex exec-server` in a Render Sandbox, and
copies the output files to your machine. The
[template source](https://github.com/render-examples/openai-agents-api-sandbox)
contains everything you run here.

Time to complete: 20 minutes, after access is enabled

## Prerequisites

1. A Render workspace with Sandboxes enabled, a
   [Render API key](https://render.com/docs/api), and your workspace ID
   (`tea-...`).
2. OpenAI Agents API access and an
   [OpenAI API key](https://platform.openai.com/api-keys) with permission to
   manage Agents API sessions.
3. A second OpenAI key, restricted to connecting self-hosted environments, for
   the executor. The runner refuses to start if the two keys are the same.
4. [Node.js](https://nodejs.org/) 22 or later and Git.

## 1. Get the template

Clone the tagged release and install its dependencies:

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/render-examples/openai-agents-api-sandbox
cd openai-agents-api-sandbox
npm ci
```

## 2. Configure credentials

Copy the example environment file:

```bash
cp .env.example .env
```

Fill in your values:

```sh
RENDER_API_KEY=rnd_your-render-api-key
RENDER_WORKSPACE_ID=tea-your-workspace-id
OPENAI_API_KEY=sk-your-application-key
OPENAI_EXECUTOR_API_KEY=sk-your-restricted-executor-key
```

`OPENAI_API_KEY` stays on your machine. Only the restricted executor key enters
the sandbox, where `codex exec-server` reads it as `CODEX_API_KEY`. To use a
different model, set `OPENAI_MODEL`.

## 3. Run the agent

Run the agent with a prompt:

```bash
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

You should see the session's progress stream to the console. Executor logs are
omitted here:

```text
provider      openai
preflight     passed
provision     sbx-...
environment   connected
prompt        submitted
progress      reasoning
progress      command_execution
progress      command_execution
agent         I created /workspace/output/server.js and confirmed it responds with "Hello, world!".
progress      message
result        task completed
outputs       copied 1 file to runs/run_.../output
cleanup       session deleted; sandbox terminated
```

Codex wrote the server, tested it inside the sandbox, and the runner copied it
to your machine. Then the runner deleted the session and terminated the
sandbox.

## 4. Understand how it works

[`src/agent.ts`](https://github.com/render-examples/openai-agents-api-sandbox/blob/v1.0.0/src/agent.ts)
runs one session from start to finish. Simplified, the lifecycle is:

```ts
await openai.preflight(signal);
const connection = await openai.createSession(model);
const sandboxId = await render.create(buildSandboxLaunchInput(executorApiKey, timeoutSeconds));
await render.waitUntilRunning(sandboxId, deadline, signal);
await render.installExecutor(sandboxId, installScript, signal, executorLog);

const sessionRun = await openai.openSessionEvents(sessionId, store);
executor = await render.startExecutor(sandboxId, remoteUrl, environmentId, signal, executorLog);
await sessionRun.waitForEnvironment();
await openai.submitPrompt(sessionId, prompt, idempotencyKey);
const result = await sessionRun.waitForCompletion();
await copyWorkspaceOutputs(render, sandboxId, localOutput, redactor, signal);

// In `finally`, on success, failure, timeout, or Ctrl+C:
await openai.deleteSession(sessionId);
await render.terminate(sandboxId);
```

Here is what the key pieces do:

| Piece | Purpose |
| --- | --- |
| `openai.preflight()` | Lists one session to confirm Agents API access before anything is created. |
| `openai.createSession()` | Creates a self-hosted session and returns its environment ID and remote URL, in [`src/openai.ts`](https://github.com/render-examples/openai-agents-api-sandbox/blob/v1.0.0/src/openai.ts). |
| `buildSandboxLaunchInput()` | Declares the egress allow-list and the only credential that enters the sandbox, in [`src/launch-policy.ts`](https://github.com/render-examples/openai-agents-api-sandbox/blob/v1.0.0/src/launch-policy.ts). |
| `install-executor.sh` | Installs `@openai/codex` 0.163.0 after checking its pinned npm integrity, in [`scripts/install-executor.sh`](https://github.com/render-examples/openai-agents-api-sandbox/blob/v1.0.0/scripts/install-executor.sh). |
| `openai.openSessionEvents()` | Opens the native session event stream before the executor connects, so no event is missed. |
| `render.startExecutor()` | Runs `codex exec-server` as a streamed foreground command in the sandbox. |
| `openai.submitPrompt()` | Sends your prompt after the environment connects, with an idempotency key. |
| `copyWorkspaceOutputs()` | Copies regular files from `/workspace/output` to your machine. |
| `openai.deleteSession()` | Deletes the session. The runner then terminates the sandbox, even if deletion failed. |

Each run writes its state to `runs/<run_id>/`: `run.json` (resource IDs,
egress policy, and cleanup status, but no credentials), the native
`events.jsonl`, `executor.log`, and `result.txt`.

## What you built

You built a coding agent that:

- Accepts a natural-language coding task
- Runs Codex's commands and file edits in an isolated Render Sandbox with
  default-deny egress
- Streams native Agents API session events as it works
- Copies deliverable files back to your machine and cleans up every per-run
  resource

## Security

Your OpenAI application key never enters the sandbox. Any code the agent runs
can read credentials that are present in the sandbox, so give the executor key
only the permissions it needs to connect the environment. The current Render
SDK has no credential broker, so the template sets the executor key as a
creation-time environment variable. That behavior is isolated in
`src/launch-policy.ts`, so a broker can replace it without changing the
lifecycle.

The sandbox's egress policy is a default-deny allow-list. At run time, the
executor needs only `api.openai.com` and
`codex-cloud-environments.chatgpt.com`. `registry.npmjs.org` is needed only to
install Codex, but the SDK cannot narrow a policy after the sandbox is created,
so it stays allowed for this short-lived run. Tool inputs and outputs pass
through OpenAI, because OpenAI hosts the agent loop.

Treat every prompt as untrusted. Don't use production credentials or sensitive
source code with this example until you have reviewed its policy and
credential settings.

## Customize the agent

- **Prompt and instructions:** the runner sends your prompt as written. Change
  the agent's instructions in `createSession()` in `src/openai.ts`, and its
  model with `OPENAI_MODEL`.
- **Toolchain:** install more tools in `scripts/install-executor.sh`, and add
  their download hosts to `INSTALL_DESTINATIONS` in `src/launch-policy.ts`.
- **Egress:** add hosts the agent needs while it works to
  `RUNTIME_DESTINATIONS` in `src/launch-policy.ts`.
- **Lifetime:** pass `--timeout <seconds>` or set `AGENT_TIMEOUT_SECONDS`
  (30–86400; the default is 600). The sandbox lifetime is derived from it in
  `src/agent.ts`.
- **Outputs:** pass `--output <path>` to copy files somewhere other than
  `runs/<run_id>/output`, or change collection in `src/outputs.ts`.

## Clean up

Cleanup runs automatically after success, failure, timeout, Ctrl+C, and
SIGTERM. Deleting the session and terminating the sandbox are independent
steps, so one failing doesn't block the other.

If a cleanup step fails, the runner prints the exact commands to finish it:

```bash
curl -X DELETE "https://api.openai.com/v1/agents/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "OpenAI-Beta: agents=v1"
RENDER_WORKSPACE="$RENDER_WORKSPACE_ID" render ea sandboxes stop "$SANDBOX_ID" --confirm
```

If session or sandbox creation fails without a clear answer from the API, the
runner also prints a `reconcile` command that lists recent resources, so you
can find and delete one that may have been created.

## Troubleshooting

### Preflight fails

Confirm your Agents API access and that `OPENAI_API_KEY` can manage sessions.

### The environment never connects

Check the `[executor:stderr]` lines and `runs/<run_id>/executor.log`. Confirm
the executor key can connect self-hosted environments.

### The task never starts

Open `runs/<run_id>/events.jsonl` and confirm that the
`agent.session.environment.connected` event arrived before the prompt was
submitted.

### The agent produces no output files

Inspect `runs/<run_id>/events.jsonl` and `result.txt`. Output files are
optional, so prompts that need files should ask Codex to write them under
`/workspace/output`.

### Cleanup is incomplete

Run the commands that the runner printed. Delete the session and terminate the
sandbox independently.

## Next steps

- [OpenAI Agents API self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- [Build a coding agent with Claude Managed Agents and Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/claude-managed-agents)
- [Build a coding agent with Cursor Cloud Agents and Render Sandboxes](https://render.com/docs/sandboxes/hosted-agents/cursor)
- [Template source](https://github.com/render-examples/openai-agents-api-sandbox)
