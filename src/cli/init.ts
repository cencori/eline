import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { createTuiPrompter } from "./setup/tui-prompter";
import type { Prompter } from "./setup/prompter";
import { scaffoldWebChat } from "./scaffold-web-chat";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from the current file to find the installed package's `templates/`
 * directory. Bundlers (tsup) may collapse `src/cli/init.ts` into a flat
 * `dist/*.js`, so `../../templates` from the source file is not a reliable
 * post-build path. The templates directory always sits at the package root
 * regardless of where the bundle lands.
 */
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

const TEMPLATES_DIR = resolveTemplatesDir();

function copyTemplate(src: string, dest: string): void {
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

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}

function updatePackageJson(dir: string, name: string): void {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.name = name;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function updateAgentName(dir: string, name: string): void {
  const agentPath = join(dir, "agent", "agent.ts");
  if (!existsSync(agentPath)) return;
  const content = readFileSync(agentPath, "utf-8");
  const updated = content.replace(/name:\s*"my-agent"/, `name: "${name}"`);
  if (updated !== content) writeFileSync(agentPath, updated);
}

function detectEnvKey(): string | null {
  return process.env.CENCORI_API_KEY ?? null;
}

function uncommentEnvLine(envPath: string, key: string, value: string): void {
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`# ${key}=`) || trimmed.startsWith(`${key}=`)) {
      return `${key}=${value}`;
    }
    return line;
  });
  if (updated.join("\n") === content) updated.push(`${key}=${value}`);
  writeFileSync(envPath, updated.join("\n") + "\n");
}

function runNpmInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = exec("npm install", { cwd });
    proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm exit ${code}`))));
    proc.once("error", reject);
  });
}

const IGNORED_DIRECTORY_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep"]);

function directoryHasMeaningfulContent(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !IGNORED_DIRECTORY_ENTRIES.has(entry));
  } catch {
    return false;
  }
}

function looksLikeArcieProject(dir: string): boolean {
  return existsSync(join(dir, "agent", "agent.ts"));
}

/**
 * Refuses to wipe a directory that is not clearly the user's project scratch
 * space. Blocks the root, the user's home, first-level system paths, and
 * anything with fewer than two non-root segments so an operator can't
 * accidentally rm-rf `/tmp` by giving init a slightly wrong argument.
 */
function assertSafeToClear(dir: string): void {
  const absolute = resolve(dir);
  const home = homedir();
  if (absolute === "/" || absolute === home) {
    throw new Error(`Refusing to clear ${absolute}: too dangerous`);
  }
  const parts = absolute.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new Error(`Refusing to clear ${absolute}: not enough path depth`);
  }
  const dangerousFirst = new Set(["etc", "var", "usr", "bin", "sbin", "System", "Library"]);
  if (parts.length === 2 && dangerousFirst.has(parts[0]!)) {
    throw new Error(`Refusing to clear ${absolute}: system path`);
  }
}

function clearDirectoryContents(dir: string): void {
  assertSafeToClear(dir);
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

export async function initCommand(
  name: string | undefined,
  options: { template: string },
): Promise<void> {
  const targetDir = name ? resolve(process.cwd(), name) : resolve(process.cwd(), ".");

  const templateDir = resolve(TEMPLATES_DIR, options.template);
  if (!existsSync(templateDir)) {
    console.error(`  Template not found: ${options.template}`);
    process.exit(1);
  }

  const prompter = createTuiPrompter();
  try {
    let mode: InitMode = "fresh";
    if (existsSync(targetDir) && directoryHasMeaningfulContent(targetDir)) {
      const decision = await resolveExistingDirectory(prompter, targetDir);
      if (decision === "cancel") return;
      if (decision === "overwrite") {
        try {
          clearDirectoryContents(targetDir);
          prompter.log.warning(`Cleared ${targetDir}`);
        } catch (err) {
          prompter.log.error(err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        mode = "resume";
      }
    }
    await runInit(prompter, { targetDir, templateDir, name, mode });
  } finally {
    prompter.stop();
  }
}

type InitMode = "fresh" | "resume";
type ExistingDirectoryDecision = "overwrite" | "resume" | "cancel";

async function resolveExistingDirectory(
  prompter: Prompter,
  targetDir: string,
): Promise<ExistingDirectoryDecision> {
  const looksArcie = looksLikeArcieProject(targetDir);
  const message = looksArcie
    ? `${targetDir} already contains an arcie project.`
    : `${targetDir} is not empty.`;
  const options = looksArcie
    ? ([
        {
          value: "resume" as const,
          label: "Resume — keep files, reconfigure model + API key",
        },
        {
          value: "overwrite" as const,
          label: "Overwrite — delete existing files and scaffold fresh",
        },
        { value: "cancel" as const, label: "Cancel" },
      ])
    : ([
        {
          value: "overwrite" as const,
          label: "Overwrite — delete existing files and scaffold fresh",
        },
        {
          value: "resume" as const,
          label: "Keep existing files and reconfigure",
        },
        { value: "cancel" as const, label: "Cancel" },
      ]);
  const choice = await prompter.select({ message, options });
  return choice ?? "cancel";
}

async function runInit(
  prompter: Prompter,
  input: { targetDir: string; templateDir: string; name: string | undefined; mode: InitMode },
): Promise<void> {
  const { targetDir, templateDir, name, mode } = input;

  const needsScaffold = mode === "fresh" || !looksLikeArcieProject(targetDir);
  if (needsScaffold) {
    const scaffold = prompter.spinner(`Creating ${targetDir}`);
    copyTemplate(templateDir, targetDir);
    if (name) {
      updatePackageJson(targetDir, name);
      updateAgentName(targetDir, name);
    }
    scaffold.stop({ kind: "success", message: `Created ${targetDir}` });
  }

  // Always scaffold the web channel — it's the default UI users chat with.
  try {
    scaffoldWebChat(targetDir);
  } catch (err) {
    prompter.log.error(`Failed to scaffold web channel: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Install root deps.
  if (!existsSync(join(targetDir, "node_modules"))) {
    const install = prompter.spinner("Installing dependencies");
    try {
      await runNpmInstall(targetDir);
      install.stop({ kind: "success", message: "Installed dependencies" });
    } catch {
      install.stop({ kind: "warning", message: "Root install failed — run `npm install` manually" });
      return;
    }
  }

  // Install web-chat deps too (Next.js, arcie for the /api/chat route, etc.).
  const webDir = join(targetDir, "channels", "web");
  if (!existsSync(join(webDir, "node_modules"))) {
    const webInstall = prompter.spinner("Installing web dependencies");
    try {
      await runNpmInstall(webDir);
      webInstall.stop({ kind: "success", message: "Installed web dependencies" });
    } catch {
      webInstall.stop({
        kind: "warning",
        message: "Web install failed — `arcie dev` will retry on start",
      });
    }
  }

  // Optional API key. Skip freely — dev still starts, first message
  // will error with a friendly "add CENCORI_API_KEY to .env.local".
  if (detectEnvKey() === null) {
    const key = await prompter.text({
      message: "Paste your CENCORI_API_KEY (or Enter to skip and add later)",
      mask: true,
    });
    if (key !== undefined && key.length > 0) {
      uncommentEnvLine(join(targetDir, ".env.local"), "CENCORI_API_KEY", key);
      process.env.CENCORI_API_KEY = key;
      prompter.log.success("Wrote CENCORI_API_KEY to .env.local");
    } else {
      prompter.log.info(`Add later: echo 'CENCORI_API_KEY=...' >> ${join(targetDir, ".env.local")}`);
    }
  }

  // Load .env.local so devCommand starts with the vars already in process.env.
  loadEnvFile(join(targetDir, ".env.local"));

  prompter.stop();
  console.log();

  const { devCommand } = await import("./dev");
  await devCommand({
    // devCommand infers project root as dirname(agentDir), so pass the
    // agent/ subdir — not the project root.
    agentDir: join(targetDir, "agent"),
    port: "3000",
    input: false,
  });
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* ignore */
  }
}
