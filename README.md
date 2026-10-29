# OpenAI coding agent on Render Sandboxes

A one-shot coding agent: send it a prompt, and the OpenAI Agents API runs the
Codex agent loop while `codex exec-server` in an ephemeral Render Sandbox runs
its commands and file edits. Files the agent writes to `/workspace/output` are
copied back to your machine.

> Render Sandboxes is in early access. The OpenAI Agents API is in beta, and
> `codex exec-server` is experimental.

Follow the tutorial:
[Run the OpenAI Agents API on Render Sandboxes](https://render.com/docs/sandboxes-openai-agents-api).

[`docs/providers/render.md`](docs/providers/render.md) is the source for the
Render page in OpenAI's
[self-hosted sandbox providers](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
docs.

## Quickstart

You need Node.js 22+, a Render workspace with Sandboxes enabled, OpenAI Agents
API access, an application API key, and an
[environment key](https://platform.openai.com/agents?tab=environments&environment_view=keys)
for the executor. Create the environment key on the Agents tab, in the same
project and user as the application key. A regular API key can't connect
environments, even with all permissions.

```bash
npm ci
cp .env.example .env   # fill in your credentials
npm run agent -- "Create a hello world HTTP server in /workspace/output. Test it before you finish."
```

Options:

```text
--timeout <seconds>  Override the 600-second deadline
--output <path>      Copy /workspace/output files to this local directory
```

Each run writes `run.json`, `events.jsonl`, `executor.log`, and `result.txt`
under `runs/<run_id>/`. `run.json` ends with `phase` set to `completed` or
`failed`, and a failed run records the reason in `error`. The runner deletes
its session and terminates its sandbox.

## Verified versions

- `openai` 7.39.0
- `@renderinc/sdk` 1.3.0
- `@openai/codex` 0.163.0 for Linux x64 and arm64, checked against pinned npm
  integrity values

## Development

```bash
npm run check   # typecheck and tests
```
