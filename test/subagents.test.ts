import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../src/loader";
import { discoverAgent } from "../src/discover/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, "fixtures", name);

describe("loadAgent — subagents", () => {
  it("loads subagents/<id>/ as self-contained child agents", async () => {
    const { manifest } = await loadAgent(fixture("agent"));

    expect(Object.keys(manifest.subagents)).toEqual(["researcher"]);
    const researcher = manifest.subagents.researcher;
    expect(researcher.config.description).toMatch(/investigates/i);
    expect(researcher.instructions).toMatch(/research specialist/i);
    expect(Object.keys(researcher.tools)).toEqual(["lookup"]);
  });

  it("keeps a subagent's own tools executable", async () => {
    const { manifest } = await loadAgent(fixture("agent"));
    const lookup = manifest.subagents.researcher.tools.lookup;
    expect(await lookup.execute({ term: "agent" } as any)).toEqual({
      term: "agent",
      definition: "stub: agent",
    });
  });

  it("rejects a subagent that omits a description", async () => {
    await expect(loadAgent(fixture("subagent-no-description"))).rejects.toThrow(
      /must declare a description/,
    );
  });

  it("rejects a subagent directory with no agent.ts", async () => {
    await expect(loadAgent(fixture("subagent-no-config"))).rejects.toThrow(
      /missing agent\.ts/,
    );
  });
});

describe("discoverAgent — subagents", () => {
  it("discovers a nested subagent with its config, instructions, and tools", () => {
    const { agent, diagnostics } = discoverAgent(fixture("agent"));

    expect(agent.subagents.map((s) => s.id)).toEqual(["researcher"]);
    const researcher = agent.subagents[0];
    expect(researcher.agentConfig?.endsWith("agent.ts")).toBe(true);
    expect(researcher.instructions?.endsWith("instructions.md")).toBe(true);
    expect(researcher.tools.map((t) => t.name)).toEqual(["lookup"]);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("reports SUBAGENT_MISSING_CONFIG when a subagent has no agent.ts", () => {
    const { diagnostics } = discoverAgent(fixture("subagent-no-config"));
    expect(
      diagnostics.some((d) => d.code === "SUBAGENT_MISSING_CONFIG" && d.severity === "error"),
    ).toBe(true);
  });
});
