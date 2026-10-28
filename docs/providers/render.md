# Render

See the [application-managed example](https://github.com/render-examples/openai-agents-api-sandbox) and the [Render tutorial](https://render.com/docs/sandboxes-openai-agents-api) for a complete, runnable implementation.

See [Self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) for executor setup and connection requirements.

This guide uses application-managed provisioning:

- **[Application-managed](#before-you-begin):** Follow this guide to start and stop Render Sandboxes from your application.

See [Sandbox lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle) to compare provisioning modes.

## Before you begin

You need an OpenAI project API key, a Render API key and workspace ID with Render Sandboxes enabled, and the Codex CLI package. Render Sandboxes is in early access.

Use `OPENAI_API_KEY` for application requests. Set `OPENAI_EXECUTOR_API_KEY` to an [environment key](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted#authentication), and pass only that key into the sandbox as `CODEX_API_KEY`.

## 1. Set up the Render environment

Create a [self-hosted session](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted#create-or-reuse-a-session) and save its environment ID and remote URL. Use the Render SDK or API to create a sandbox with a default-deny network policy that allows `api.openai.com` and `codex-cloud-environments.chatgpt.com`, plus your package registry while you install tools. Wait until the sandbox is running. Install the Codex CLI in the sandbox, then [start its executor](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted#start-the-executor) with that environment ID and the environment key, using `/workspace` as the configured working directory.

## 2. Run the session

Use the HTTP examples in [Run and continue sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions) to send input and stream the result after the Render executor connects. When finished, [delete the session](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage#delete-a-session) and terminate the Render Sandbox separately.

## References

- Read [Render Sandboxes documentation](https://render.com/docs/sandboxes)
- Read [Run the OpenAI Agents API on Render Sandboxes](https://render.com/docs/sandboxes-openai-agents-api)
- Read [Render TypeScript SDK source](https://github.com/render-oss/sdk/tree/main/typescript)
