import type { SandboxCreateInput } from "@renderinc/sdk/experimental";

export const EGRESS_DESTINATIONS = [
  "api.openai.com",
  "codex-cloud-environments.chatgpt.com",
  "registry.npmjs.org",
] as const;

export const CREDENTIAL_DELIVERY_MODE = "creation-env-compatibility-seam" as const;

/**
 * This is the only module allowed to place a credential into Sandbox creation.
 *
 * @renderinc/sdk 1.3.0 supports hostname allow-lists but does not yet expose a
 * destination-bound credential broker. Until that public shape exists, the
 * restricted executor key is materialized as CODEX_API_KEY at creation time.
 * OPENAI_API_KEY is deliberately absent.
 */
export function buildSandboxLaunchInput(
  executorApiKey: string,
  timeoutSeconds: number,
): SandboxCreateInput {
  return {
    timeoutSeconds,
    networkPolicy: {
      type: "allow-list",
      rules: EGRESS_DESTINATIONS.map((domain) => ({ domain, protocol: "https" })),
    },
    env: {
      CODEX_API_KEY: executorApiKey,
    },
  };
}
