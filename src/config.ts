export interface Config {
  renderApiKey: string;
  renderWorkspaceId: `tea-${string}`;
  openaiApiKey: string;
  openaiExecutorApiKey: string;
  openaiModel: string;
  timeoutMs: number;
  outputDirectory?: string;
}

const REQUIRED = [
  "RENDER_API_KEY",
  "RENDER_WORKSPACE_ID",
  "OPENAI_API_KEY",
  "OPENAI_EXECUTOR_API_KEY",
] as const;

export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: { timeoutSeconds?: number; outputDirectory?: string } = {},
): Config {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const workspaceId = env.RENDER_WORKSPACE_ID!.trim();
  if (!workspaceId.startsWith("tea-")) {
    throw new Error("RENDER_WORKSPACE_ID must start with tea-");
  }
  if (env.OPENAI_API_KEY === env.OPENAI_EXECUTOR_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY and OPENAI_EXECUTOR_API_KEY must be separate credentials",
    );
  }

  const timeoutSeconds =
    overrides.timeoutSeconds ??
    parsePositiveInteger(env.AGENT_TIMEOUT_SECONDS ?? "600", "AGENT_TIMEOUT_SECONDS");
  if (timeoutSeconds < 30 || timeoutSeconds > 86_400) {
    throw new Error("Timeout must be between 30 and 86400 seconds");
  }

  const config: Config = {
    renderApiKey: env.RENDER_API_KEY!.trim(),
    renderWorkspaceId: workspaceId as `tea-${string}`,
    openaiApiKey: env.OPENAI_API_KEY!.trim(),
    openaiExecutorApiKey: env.OPENAI_EXECUTOR_API_KEY!.trim(),
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-6-astra",
    timeoutMs: timeoutSeconds * 1_000,
  };
  const outputDirectory = overrides.outputDirectory?.trim();
  if (outputDirectory) config.outputDirectory = outputDirectory;
  return config;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}
