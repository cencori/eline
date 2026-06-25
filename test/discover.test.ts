import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgent } from "../src/discover/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/agent");

function tempAgent(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "zett-discover-"));
  build(dir);
  return dir;
}

describe("discoverAgent — happy path", () => {
  const { agent, diagnostics } = discoverAgent(FIXTURE);

  it("finds the agent config and instructions", () => {
    expect(agent.agentConfig?.endsWith("agent.ts")).toBe(true);
    expect(agent.instructions?.endsWith("instructions.md")).toBe(true);
  });

  it("discovers tools sorted by name", () => {
    expect(agent.tools.map((t) => t.name)).toEqual(["add", "echo"]);
    expect(agent.tools.every((t) => t.type === "module")).toBe(true);
  });

  it("produces no error-level diagnostics", () => {
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });
});

describe("discoverAgent — diagnostics", () => {
  it("reports AGENT_DIR_NOT_FOUND for a missing directory", () => {
    const { diagnostics } = discoverAgent(join(tmpdir(), "zett-nope-does-not-exist"));
    expect(diagnostics.some((d) => d.code === "AGENT_DIR_NOT_FOUND" && d.severity === "error")).toBe(true);
  });

  it("warns on an invalid slot name", () => {
    const dir = tempAgent((d) => {
      mkdirSync(join(d, "tools"));
      writeFileSync(join(d, "tools", "Bad Name.ts"), "export default {}");
    });
    try {
      const { diagnostics } = discoverAgent(dir);
      expect(diagnostics.some((d) => d.code === "INVALID_SLOT_NAME")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns that system.md is deprecated in favour of instructions.md", () => {
    const dir = tempAgent((d) => writeFileSync(join(d, "system.md"), "legacy"));
    try {
      const { agent, diagnostics } = discoverAgent(dir);
      expect(agent.instructions?.endsWith("system.md")).toBe(true);
      expect(diagnostics.some((d) => d.code === "DEPRECATED_SYSTEM_SLOT")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("errors when a flat module slot collides (agent.ts + agent.js)", () => {
    const dir = tempAgent((d) => {
      writeFileSync(join(d, "agent.ts"), "export default {}");
      writeFileSync(join(d, "agent.js"), "export default {}");
    });
    try {
      const { diagnostics } = discoverAgent(dir);
      expect(diagnostics.some((d) => d.code === "MODULE_SLOT_COLLISION" && d.severity === "error")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
