import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import type {
  AgentManifest,
  AgentConfig,
  ToolConfig,
  SkillConfig,
  HookConfig,
  ChannelConfig,
  ConnectionConfig,
  ScheduleConfig,
  SessionConfig,
  PolicyConfig,
  SubagentManifest,
} from "./types";

export interface LoadedAgent {
  manifest: AgentManifest;
  agentDir: string;
  /** Stable identifier for this agent within the project. `"agent"` for the primary. */
  id: string;
}

export const PRIMARY_AGENT_ID = "agent";

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
    } catch (err) {
      console.warn(`[arcie] Failed to load agent.ts: ${(err as Error).message}. Using defaults.`);
    }
  }

  const instructions = loadInstructionsFile(absDir);
  const tools = await loadDirectory<ToolConfig>(absDir, "tools");
  const skills = await loadDirectory<SkillConfig>(absDir, "skills");
  const hooks = await loadDirectory<HookConfig>(absDir, "hooks");
  const channels = await loadDirectory<ChannelConfig>(absDir, "channels");
  const connections = await loadDirectory<ConnectionConfig>(absDir, "connections");
  const schedules = await loadDirectory<ScheduleConfig>(absDir, "schedules");
  const directorySubagents = await loadSubagents(absDir);
  const inlineSubagents = materializeInlineSubagents(config.subagents);
  // Directory-based entries win on id collision — they're more explicit and
  // typically pre-existing.
  const subagents = { ...inlineSubagents, ...directorySubagents };
  const session = await loadSessionConfig(absDir);
  const policy = await loadPolicyConfig(absDir);

  return {
    id: PRIMARY_AGENT_ID,
    agentDir: absDir,
    manifest: {
      config,
      instructions,
      tools,
      skills,
      hooks,
      channels,
      connections,
      schedules,
      subagents,
      session: session ?? undefined,
      policy: policy ?? undefined,
    },
  };
}

/**
 * Loads an inline top-level agent — a single `.ts` file at the root of the
 * agent directory (e.g. `agent/researcher.ts`). Inline agents own their
 * tools + instructions inside the file's `defineAgent({...})` call; sibling
 * `tools/`, `subagents/`, `instructions.md` are not traversed. This is the
 * self-contained path for adding multiple top-level agents without carving
 * out a directory per one.
 */
export async function loadInlineAgent(agentDir: string, id: string): Promise<LoadedAgent> {
  const absDir = resolve(process.cwd(), agentDir);
  const filePath = resolve(absDir, `${id}.ts`);
  if (!existsSync(filePath)) {
    throw new Error(`Agent not found: ${filePath}`);
  }

  let mod: { default?: AgentConfig };
  try {
    mod = await import(filePath);
  } catch (err) {
    throw new Error(`Failed to load ${id}.ts: ${(err as Error).message}`);
  }
  const config = mod.default;
  if (!config) {
    throw new Error(`${id}.ts must default-export a defineAgent({...}) result`);
  }

  return {
    id,
    agentDir: absDir,
    manifest: {
      config,
      instructions: config.instructions ?? "You are a helpful AI agent.",
      tools: config.tools ?? {},
      skills: {},
      hooks: {},
      channels: {},
      connections: {},
      schedules: {},
      subagents: materializeInlineSubagents(config.subagents),
    },
  };
}

/**
 * Converts an inline `config.subagents` map (from `defineAgent({subagents: {...}})`)
 * into the `SubagentManifest` shape the runner already handles. Every entry
 * must declare a description so the orchestrator knows when to delegate.
 */
function materializeInlineSubagents(
  configs: Record<string, AgentConfig> | undefined,
): Record<string, SubagentManifest> {
  if (configs === undefined) return {};
  const result: Record<string, SubagentManifest> = {};
  for (const [id, subConfig] of Object.entries(configs)) {
    if (!subConfig.description || subConfig.description.length === 0) {
      throw new Error(`Inline subagent "${id}" must declare a description`);
    }
    result[id] = {
      config: subConfig,
      instructions: subConfig.instructions ?? "You are a helpful subagent.",
      tools: subConfig.tools ?? {},
      skills: {},
    };
  }
  return result;
}

/**
 * Dispatches to `loadAgent` for the primary (`agent`) or `loadInlineAgent`
 * for any additional top-level `.ts` file. Runners and the HTTP server use
 * this so callers don't need to know the discovery mechanics.
 */
export async function loadAgentById(agentDir: string, id: string): Promise<LoadedAgent> {
  if (id === PRIMARY_AGENT_ID) return loadAgent(agentDir);
  return loadInlineAgent(agentDir, id);
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

/**
 * Discovers every top-level agent under `agentDir`: the primary (`agent.ts`)
 * plus any sibling `.ts` file at the same depth. Directory-based subagents
 * (under `subagents/`) are not included here — those belong to the agent
 * that owns them.
 */
export function discoverAgents(agentDir: string): Array<{ id: string; filePath: string }> {
  const absDir = resolve(process.cwd(), agentDir);
  if (!existsSync(absDir)) return [];
  const results: Array<{ id: string; filePath: string }> = [];
  const primaryPath = resolve(absDir, "agent.ts");
  if (existsSync(primaryPath)) {
    results.push({ id: PRIMARY_AGENT_ID, filePath: primaryPath });
  }
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "agent.ts") continue;
    if (!entry.name.endsWith(".ts")) continue;
    const id = entry.name.replace(/\.ts$/, "");
    results.push({ id, filePath: resolve(absDir, entry.name) });
  }
  return results;
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

async function loadSessionConfig(agentDir: string): Promise<SessionConfig | null> {
  const tsPath = resolve(agentDir, "sessions", "config.ts");
  if (existsSync(tsPath)) {
    try {
      const mod = await import(tsPath);
      return mod.default ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function loadPolicyConfig(agentDir: string): Promise<PolicyConfig | null> {
  const tsPath = resolve(agentDir, "policies", "index.ts");
  if (existsSync(tsPath)) {
    try {
      const mod = await import(tsPath);
      return mod.default ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
