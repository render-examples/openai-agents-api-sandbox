import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Redactor } from "./redaction.js";
import type { RenderSandbox } from "./render.js";
import { shellQuote } from "./render.js";

export async function copyWorkspaceOutputs(
  render: RenderSandbox,
  sandboxId: string,
  localDirectory: string,
  redactor: Redactor,
  signal: AbortSignal,
): Promise<string[]> {
  const listing = await render.execBuffered(
    sandboxId,
    "if [ -d /workspace/output ]; then find -P /workspace/output -type f -printf '%P\\0'; fi",
    signal,
    undefined,
    4 * 1024 * 1024,
  );
  if (listing.exitCode !== 0) {
    throw new Error(`Could not list /workspace/output: ${listing.stderr.trim()}`);
  }

  const files = listing.stdout.split("\0").filter(Boolean);
  const root = resolve(localDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });

  for (const relativePath of files) {
    assertSafeRelativePath(relativePath);
    const destination = resolve(root, ...relativePath.split("/"));
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe output path: ${relativePath}`);
    }

    const remotePath = posix.join("/workspace/output", relativePath);
    const data = await render.download(sandboxId, remotePath, signal);
    redactor.assertSafeBytes(data, remotePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  }

  return files;
}

function assertSafeRelativePath(value: string): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe output path: ${shellQuote(value)}`);
  }
}
