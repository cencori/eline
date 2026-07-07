import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentSourcePath(agentDir: string): string {
  return join(agentDir, "agent", "agent.ts");
}

export function envLocalPath(agentDir: string): string {
  return join(agentDir, ".env.local");
}

export function readAgentModel(agentDir: string): string | undefined {
  const path = agentSourcePath(agentDir);
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf-8");
    return content.match(/model:\s*"([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

export function writeAgentModel(agentDir: string, model: string): boolean {
  const path = agentSourcePath(agentDir);
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf-8");
  const updated = content.replace(/model:\s*"[^"]+"/, `model: "${model}"`);
  if (updated === content) return false;
  writeFileSync(path, updated);
  return true;
}

export const PROVIDER_KEYS = [
  "CENCORI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY",
  "TOGETHER_API_KEY",
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export interface ProviderKeyStatus {
  readonly key: string;
  readonly set: boolean;
  readonly source?: "env" | "file";
  readonly masked?: string;
}

export function providerKeyStatus(agentDir: string): ProviderKeyStatus[] {
  const fileValues = readEnvLocal(agentDir);
  return PROVIDER_KEYS.map((key) => {
    const envValue = process.env[key];
    if (envValue && envValue.length > 0) {
      return { key, set: true, source: "env" as const, masked: maskSecret(envValue) };
    }
    const fileValue = fileValues[key];
    if (fileValue && fileValue.length > 0) {
      return { key, set: true, source: "file" as const, masked: maskSecret(fileValue) };
    }
    return { key, set: false };
  });
}

export function readEnvLocal(agentDir: string): Record<string, string> {
  const envPath = envLocalPath(agentDir);
  if (!existsSync(envPath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) values[key] = value;
  }
  return values;
}

/**
 * Writes `key=value` to `.env.local`, replacing an existing declaration
 * (commented or not) or appending a new line. Returns true if the file was
 * changed.
 */
export function upsertEnvLocal(agentDir: string, key: string, value: string): boolean {
  const envPath = envLocalPath(agentDir);
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${key}=${value}\n`);
    return true;
  }
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  let replaced = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`# ${key}=`) || trimmed.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) updated.push(`${key}=${value}`);
  const next = updated.join("\n") + (updated.at(-1) === "" ? "" : "\n");
  if (next === content) return false;
  writeFileSync(envPath, next);
  return true;
}

export interface ChannelSummary {
  readonly name: string;
  readonly path: string;
}

export function listChannels(agentDir: string): ChannelSummary[] {
  const channelsDir = join(agentDir, "channels");
  if (!existsSync(channelsDir)) return [];
  try {
    return readdirSync(channelsDir)
      .filter((entry) => {
        const full = join(channelsDir, entry);
        return statSync(full).isDirectory();
      })
      .map((name) => ({ name, path: join(channelsDir, name) }));
  } catch {
    return [];
  }
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(6)}${value.slice(-4)}`;
}
