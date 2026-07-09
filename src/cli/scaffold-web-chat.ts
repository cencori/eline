import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveTemplatesDir(): string {
  let current = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(current, "templates");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(__dirname, "../../templates");
}

const EXCLUDED_ENTRIES = new Set([
  "node_modules",
  ".next",
  ".vercel",
  "dist",
  "build",
  "out",
  ".env",
  ".env.local",
]);

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_ENTRIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}

function copyTemplateTree(src: string, dest: string): void {
  for (const entry of collectFiles(src)) {
    const relative = entry.replace(src, "").replace(/^\//, "");
    const destPath = join(dest, relative);
    if (entry.endsWith(".gitkeep")) {
      const parentDir = destPath.replace("/.gitkeep", "");
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(join(parentDir, ".gitkeep"), "");
      continue;
    }
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(entry, destPath);
  }
}

export interface ScaffoldWebChatResult {
  readonly targetPath: string;
  readonly alreadyExisted: boolean;
}

/**
 * Copies the web-chat template into `<agentDir>/channels/web`. If the target
 * already exists, leaves it untouched and reports so callers can decide
 * whether to prompt for overwrite.
 */
export function scaffoldWebChat(agentDir: string): ScaffoldWebChatResult {
  const source = resolve(resolveTemplatesDir(), "web-chat");
  const target = join(agentDir, "channels", "web");
  if (existsSync(target)) {
    return { targetPath: target, alreadyExisted: true };
  }
  mkdirSync(target, { recursive: true });
  copyTemplateTree(source, target);
  return { targetPath: target, alreadyExisted: false };
}
