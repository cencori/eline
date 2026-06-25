import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineAgent } from "../src/agent/index";
import { defineTool } from "../src/tools/index";
import { defineInstructions } from "../src/instructions/index";
import { defineSkill } from "../src/skills/index";
import { defineHook } from "../src/hooks/index";
import { defineChannel } from "../src/channels/index";
import { defineSchedule } from "../src/schedules/index";

describe("defineAgent", () => {
  it("returns the config when a model is present", () => {
    const cfg = defineAgent({ model: "claude-sonnet-4-5", name: "x" });
    expect(cfg).toEqual({ model: "claude-sonnet-4-5", name: "x" });
  });
  it("throws when model is missing", () => {
    expect(() => defineAgent({} as any)).toThrow(/must specify a model/);
  });
});

describe("defineTool", () => {
  it("returns the config and keeps a runnable execute()", async () => {
    const tool = defineTool({
      description: "Add",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => a + b,
    });
    expect(tool.description).toBe("Add");
    expect(await tool.execute({ a: 2, b: 3 })).toBe(5);
  });
  it("throws without a description", () => {
    expect(() => defineTool({ execute: () => 1 } as any)).toThrow(/must have a description/);
  });
  it("throws without an execute function", () => {
    expect(() => defineTool({ description: "x" } as any)).toThrow(/must have an execute/);
  });
});

describe("defineInstructions", () => {
  it("passes through an object source", () => {
    expect(defineInstructions({ content: "hello" })).toEqual({ content: "hello" });
  });
  it("loads a file when given a path", () => {
    const ins = defineInstructions("README.md");
    expect(ins.content.length).toBeGreaterThan(0);
    expect(ins.filePath?.endsWith("README.md")).toBe(true);
  });
  it("throws on a missing file path", () => {
    expect(() => defineInstructions("does-not-exist-xyz.md")).toThrow(/not found/);
  });
});

describe("the remaining validators reject incomplete configs", () => {
  it("defineSkill requires name + content", () => {
    expect(() => defineSkill({ name: "s" } as any)).toThrow(/name and content/);
    expect(defineSkill({ name: "s", description: "", content: "c" }).content).toBe("c");
  });
  it("defineHook requires name + event + handler", () => {
    expect(() => defineHook({ name: "h", event: "beforeTurn" } as any)).toThrow(/name, event, and handler/);
    const h = defineHook({ name: "h", event: "beforeTurn", handler: () => {} });
    expect(h.event).toBe("beforeTurn");
  });
  it("defineChannel requires name + handler", () => {
    expect(() => defineChannel({ name: "c" } as any)).toThrow(/name and handler/);
  });
  it("defineSchedule requires name + cron + handler", () => {
    expect(() => defineSchedule({ name: "s", cron: "* * * * *" } as any)).toThrow(/name, cron, and handler/);
    const s = defineSchedule({ name: "s", cron: "* * * * *", handler: () => {} });
    expect(s.cron).toBe("* * * * *");
  });
});
