import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_DESTINATIONS } from "../../src/launch-policy.js";

const root = process.cwd();

describe("OpenAI provider page", async () => {
  const page = await readFile(join(root, "docs", "providers", "render.md"), "utf8");
  const openai = await readFile(join(root, "src", "openai.ts"), "utf8");

  it("follows the OpenAI provider page structure", () => {
    const headings = [...page.matchAll(/^#{1,2} (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "Render",
      "Before you begin",
      "1. Set up the Render environment",
      "2. Run the session",
      "References",
    ]);
  });

  it("uses only absolute links, since it is published on developers.openai.com", () => {
    const links = [...page.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    for (const link of links) expect(link, link).toMatch(/^(https:\/\/|#)/);
  });

  it("matches the template's credentials, egress, and working directory", () => {
    for (const name of ["OPENAI_API_KEY", "OPENAI_EXECUTOR_API_KEY", "CODEX_API_KEY"]) {
      expect(page).toContain(`\`${name}\``);
    }
    for (const host of RUNTIME_DESTINATIONS) expect(page).toContain(`\`${host}\``);
    const workspace = openai.match(/workspace_directory: "([^"]+)"/)?.[1];
    expect(page).toContain(`\`${workspace}\` as the configured working directory`);
  });
});
