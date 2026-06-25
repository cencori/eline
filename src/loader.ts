import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
import type {
  AgentManifest,
  AgentConfig,
  ToolConfig,
  SkillConfig,
  HookConfig,
  ChannelConfig,
  ScheduleConfig,
  SessionConfig,
  PolicyConfig,
  SubagentManifest,
} from "./types";

export interface LoadedAgent {
  manifest: AgentManifest;
  agentDir: string;
}

export async function loadAgent(agentDir: string): Promise<LoadedAgent> {
  const absDir = resolve(process.cwd(), agentDir);

  if (!existsSync(absDir)) {
    throw new Error(`Agent directory not found: ${absDir}`);
  }

  const agentFile = resolve(absDir, "agent.ts");
  let config: AgentConfig = { model: "gpt-4o" };

  if (existsSync(agentFile)) {
    try {
      const mod = await import(agentFile);
      if (mod.default) {
        config = { ...config, ...mod.default };
      }
    } catch {
      // fall back to defaults
    }
  }

  const instructions = loadInstructionsFile(absDir);
  const tools = await loadDirectory<ToolConfig>(absDir, "tools");
  const skills = await loadDirectory<SkillConfig>(absDir, "skills");
  const hooks = await loadDirectory<HookConfig>(absDir, "hooks");
  const channels = await loadDirectory<ChannelConfig>(absDir, "channels");
  const schedules = await loadDirectory<ScheduleConfig>(absDir, "schedules");
  const subagents = await loadSubagents(absDir);
  const session = loadSessionConfig(absDir);
  const policy = loadPolicyConfig(absDir);

  return {
    agentDir: absDir,
    manifest: {
      config,
      instructions,
      tools,
      skills,
      hooks,
      channels,
      schedules,
      subagents,
      session: session ?? undefined,
      policy: policy ?? undefined,
    },
  };
}

/**
 * Loads each `subagents/<id>/` directory as a self-contained child agent.
 * Unlike the other slots, subagents are *directories* (not flat files): every
 * one is a mini-agent with its own config, instructions, tools, and skills.
 * A subagent must declare a `description` so the orchestrator knows when to
 * delegate to it — a missing one is a hard authoring error.
 */
async function loadSubagents(
  agentDir: string
): Promise<Record<string, SubagentManifest>> {
  const dirPath = resolve(agentDir, "subagents");
  if (!existsSync(dirPath)) return {};

  const result: Record<string, SubagentManifest> = {};

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const id = entry.name;
    const subDir = resolve(dirPath, id);

    const agentFile = resolve(subDir, "agent.ts");
    if (!existsSync(agentFile)) {
      throw new Error(`Subagent "${id}" is missing agent.ts`);
    }

    let mod: { default?: AgentConfig };
    try {
      mod = await import(agentFile);
    } catch (err) {
      throw new Error(`Failed to load subagent "${id}": ${(err as Error).message}`);
    }

    const config = mod.default;
    if (!config) {
      throw new Error(`Subagent "${id}" agent.ts must have a default export`);
    }
    if (!config.description) {
      throw new Error(`Subagent "${id}" must declare a description in agent.ts`);
    }

    result[id] = {
      config,
      instructions: loadInstructionsFile(subDir),
      tools: await loadDirectory<ToolConfig>(subDir, "tools"),
      skills: await loadDirectory<SkillConfig>(subDir, "skills"),
    };
  }

  return result;
}

function loadInstructionsFile(agentDir: string): string {
  const mdPath = resolve(agentDir, "instructions.md");
  if (existsSync(mdPath)) {
    return readFileSync(mdPath, "utf-8");
  }
  return "You are a helpful AI agent.";
}

async function loadDirectory<T>(
  agentDir: string,
  dirName: string
): Promise<Record<string, T>> {
  const dirPath = resolve(agentDir, dirName);
  if (!existsSync(dirPath)) return {};

  const entries = readdirSync(dirPath).filter(
    (f) => !f.startsWith(".") && (f.endsWith(".ts") || f.endsWith(".js"))
  );

  const result: Record<string, T> = {};

  for (const entry of entries) {
    const name = basename(entry, extname(entry));
    const filePath = resolve(dirPath, entry);

    if (statSync(filePath).isFile()) {
      try {
        const mod = await import(filePath);
        if (mod.default) {
          result[name] = mod.default;
        }
      } catch {
        // skip unloadable files
      }
    }
  }

  return result;
}

function loadSessionConfig(agentDir: string): SessionConfig | null {
  const tsPath = resolve(agentDir, "sessions", "config.ts");
  if (existsSync(tsPath)) {
    try {
      const mod = _require(tsPath);
      return mod.default ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function loadPolicyConfig(agentDir: string): PolicyConfig | null {
  const tsPath = resolve(agentDir, "policies", "index.ts");
  if (existsSync(tsPath)) {
    try {
      const mod = _require(tsPath);
      return mod.default ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
