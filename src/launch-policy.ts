import type { SandboxCreateInput } from "@renderinc/sdk/experimental";

/** Hosts `codex exec-server` needs while it serves the session. */
export const RUNTIME_DESTINATIONS = [
  "api.openai.com",
  "codex-cloud-environments.chatgpt.com",
] as const;

/**
 * Hosts used only to install the pinned Codex release. The SDK cannot narrow a
 * policy after creation, so they stay allowed for this short-lived run.
 */
export const INSTALL_DESTINATIONS = ["registry.npmjs.org"] as const;

export const EGRESS_DESTINATIONS = [...RUNTIME_DESTINATIONS, ...INSTALL_DESTINATIONS];

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
