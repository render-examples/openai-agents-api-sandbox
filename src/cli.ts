import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { OpenAIAgents } from "./openai.js";
import { Redactor } from "./redaction.js";
import { RenderSandbox } from "./render.js";

interface Arguments {
  prompt: string;
  timeoutSeconds?: number;
  outputDirectory?: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = loadConfig(process.env, {
    ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
    ...(args.outputDirectory === undefined ? {} : { outputDirectory: args.outputDirectory }),
  });
  const redactor = new Redactor([
    config.renderApiKey,
    config.openaiApiKey,
    config.openaiExecutorApiKey,
  ]);
  const openai = new OpenAIAgents(config.openaiApiKey, redactor);
  const render = new RenderSandbox(
    config.renderApiKey,
    config.renderWorkspaceId,
    redactor,
  );
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const timeout = setTimeout(
    () => controller.abort(new Error(`Agent deadline exceeded after ${config.timeoutMs / 1_000}s`)),
    config.timeoutMs,
  );

  try {
    await runAgent(args.prompt, config, openai, render, redactor, controller.signal);
  } catch (error) {
    console.error(`error         ${redactor.text(formatError(error))}`);
    process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

export function parseArguments(argv: string[]): Arguments {
  let prompt: string | undefined;
  let timeoutSeconds: number | undefined;
  let outputDirectory: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--timeout") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("--timeout requires a positive integer number of seconds");
      }
      timeoutSeconds = Number(value);
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a path");
      outputDirectory = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (prompt === undefined) {
      prompt = argument;
    } else {
      throw new Error("Pass the prompt as one quoted argument");
    }
  }

  if (!prompt?.trim()) {
    throw new Error(
      'Usage: npm run agent -- "<prompt>" [--timeout <seconds>] [--output <path>]',
    );
  }
  return {
    prompt,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((item) => formatError(item))].join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(`error         ${formatError(error)}`);
    process.exitCode = 1;
  });
}
