import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverAgents, loadAgent, loadAgentById } from "../loader";
import { discoverAgent } from "../discover/index";
import { streamAgent } from "../runner/index";
import { showHeader } from "./banner";
import { grey, dimmed } from "./style";
import { startBlockChat } from "./tui/renderer/start-block-chat";
import { handleSessionsRequest, getProviderApiKey, resolveProviderForModel } from "../server/index";

export interface DevOptions {
  port: string;
  agentDir: string;
  input?: boolean;
  /** Skip auto-starting the web/ dev server even when it exists. */
  noWeb?: boolean;
  /** Skip auto-opening the browser at the web channel URL. */
  noOpen?: boolean;
}

function checkProviderKeys(modelId: string): string[] {
  const provider = resolveProviderForModel(modelId);
  const missing: string[] = [];

  const envVar = PROVIDER_KEY_NAMES[provider];
  if (envVar && !process.env[envVar] && !getProviderApiKey(provider)) {
    missing.push(envVar);
  }

  return missing;
}

const MAX_PORT_ATTEMPTS = 10;

function tryListen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

async function listenWithFallback(
  server: ReturnType<typeof createServer>,
  startPort: number,
): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    try {
      await tryListen(server, port);
      return port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `Could not find a free port in ${startPort}..${startPort + MAX_PORT_ATTEMPTS - 1}`,
  );
}

function isPortFree(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}

async function findFreePort(startPort: number, maxAttempts = MAX_PORT_ATTEMPTS, host?: string): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    // A wildcard bind can succeed while 127.0.0.1 is separately taken
    // (and vice versa), so a port only counts as free when both are —
    // otherwise "localhost" in the browser can resolve to a different
    // server than the one we started.
    const free = host
      ? await isPortFree(port, host)
      : (await isPortFree(port)) && (await isPortFree(port, "127.0.0.1"));
    if (free) return port;
  }
  throw new Error(`No free port in ${startPort}..${startPort + maxAttempts - 1}`);
}

/**
 * The local engine's gateway lives well away from the 3000-range that
 * Next.js walks when its preferred port is taken — otherwise the
 * gateway can occupy the exact port Next falls back to (or vice versa)
 * and the browser lands on the wrong server.
 */
const LOCAL_GATEWAY_BASE_PORT = 41100;

const CLOUD_ENDPOINT = "https://cencori.com/api/v1";

const PROVIDER_KEY_NAMES: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
  meta: "TOGETHER_API_KEY",
};

function providerKeyName(provider: string): string {
  return PROVIDER_KEY_NAMES[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

/** A real Cencori key, not the placeholder we inject for keyless local dev. */
function hasCencoriKey(): boolean {
  const key = process.env.CENCORI_API_KEY;
  return typeof key === "string" && key.length > 0 && key !== "local-dev-key";
}

/** Reachable = any HTTP response at all; only network-level failures count as down. */
async function isReachable(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

interface EngineChoice {
  mode: "explicit" | "cloud" | "local" | "failover" | "cloud-unreachable";
  provider: string;
}

/**
 * Decides which engine serves the agent loop. The product contract is:
 * a CENCORI_API_KEY is the only key a user needs — models come from
 * Cencori. So the cloud gateway is canonical whenever that key exists,
 * and the local engine (direct provider calls) is either a BYOK mode
 * for users without a Cencori key, or an automatic failover when
 * cencori.com is unreachable and a provider key happens to be present.
 * CENCORI_API_URL overrides everything.
 */
async function chooseEngine(agentModel: string): Promise<EngineChoice> {
  const provider = agentModel ? resolveProviderForModel(agentModel) : "";
  const providerKeyAvailable = provider !== "" && getProviderApiKey(provider) !== undefined;

  if (process.env.CENCORI_API_URL) return { mode: "explicit", provider };

  if (hasCencoriKey()) {
    if (await isReachable(CLOUD_ENDPOINT)) return { mode: "cloud", provider };
    if (providerKeyAvailable) return { mode: "failover", provider };
    return { mode: "cloud-unreachable", provider };
  }

  if (providerKeyAvailable) return { mode: "local", provider };
  return { mode: "cloud", provider };
}

function describeEngine(engine: EngineChoice): string {
  switch (engine.mode) {
    case "explicit":
      return process.env.CENCORI_API_URL!;
    case "cloud":
    case "cloud-unreachable":
      return `cencori cloud`;
    case "failover":
      return `local (${engine.provider} direct) ${grey("\xB7")} cloud failover`;
    case "local":
      return `local (${engine.provider} direct)`;
  }
}

/**
 * Boots the local sessions gateway on a loopback port and returns its
 * base URL, or undefined when no port is available.
 */
async function startLocalGateway(): Promise<string | undefined> {
  const gateway = createServer(async (req, res) => {
    if (await handleSessionsRequest(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  try {
    const port = await findFreePort(LOCAL_GATEWAY_BASE_PORT, MAX_PORT_ATTEMPTS, "127.0.0.1");
    await new Promise<void>((resolveListen, rejectListen) => {
      gateway.once("error", rejectListen);
      gateway.listen(port, "127.0.0.1", resolveListen);
    });
    return `http://127.0.0.1:${port}/v1`;
  } catch {
    return undefined;
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // Non-fatal: user can copy the URL from the console.
  }
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      // fetch throws for connection refused — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface WebChannelHandle {
  readonly url: string;
  readonly process: ChildProcess;
}

/**
 * Spawns the web/ dev server as a child process, waits for it to come up,
 * and returns a handle the caller can kill on shutdown. Returns undefined
 * when the directory isn't scaffolded, isn't installed, or fails to start
 * in time.
 */
async function installWebDeps(webDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "--no-fund", "--no-audit"], {
      cwd: webDir,
      stdio: "ignore",
    });
    child.once("exit", (code) => resolve(code === 0));
    child.once("error", () => resolve(false));
  });
}

async function startWebChannel(
  agentDir: string,
  webPort: number,
): Promise<WebChannelHandle | undefined> {
  const projectRoot = dirname(agentDir);
  const webDir = join(projectRoot, "web");
  if (!existsSync(join(webDir, "package.json"))) return undefined;

  if (!existsSync(join(webDir, "node_modules"))) {
      console.log(`  ${dimmed(`web    installing deps (first run)…`)}`);
    const installed = await installWebDeps(webDir);
    if (!installed) {
      console.log();
      console.log(`  ${grey("⚠")} web install failed — try manually:`);
      console.log(`  ${dimmed(`  cd ${webDir} && npm install`)}`);
      console.log();
      return undefined;
    }
  }

  // ARCIE_AGENT_DIR points the Next.js /api/chat route at the agent
  // files it should run. streamAgent() is called in-process now — no
  // proxying, no separate arcie HTTP server. PORT is a hint: Next.js
  // owns port selection (it falls back on conflicts itself), so we read
  // the URL it actually bound from its output rather than probing and
  // second-guessing it.
  // Explicit ports make Next.js hard-fail when taken, so hint with a
  // port that's actually free; the reported URL is still authoritative.
  let portHint = webPort;
  if (!(await isPortFree(webPort)) || !(await isPortFree(webPort, "127.0.0.1"))) {
    try {
      portHint = await findFreePort(webPort + 1);
    } catch {
      /* let Next.js report the conflict itself */
    }
  }

  const child = spawn("npm", ["run", "dev"], {
    cwd: webDir,
    env: {
      ...process.env,
      ARCIE_AGENT_DIR: agentDir,
      PORT: String(portHint),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const url = (await readNextLocalUrl(child, 45_000)) ?? `http://localhost:${portHint}`;
  const ready = await waitForHttp(url, 45_000);
  if (!ready) {
    console.log();
    console.log(`  ${grey("⚠")} web didn't come up within 45s`);
    child.kill();
    return undefined;
  }

  return { url, process: child };
}

/**
 * Watches the spawned dev server's output for the "Local: http://…"
 * line Next.js prints once it has bound a port. Returns undefined if
 * the line never shows (unusual output format) — callers fall back to
 * the requested port.
 */
function readNextLocalUrl(child: ChildProcess, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      resolve(url);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/Local:\s+(https?:\/\/\S+)/);
      if (match) finish(match[1]!.replace(/\/+$/, ""));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", () => finish(undefined));
  });
}

export async function devCommand(options: DevOptions): Promise<void> {
  const agentDirPath = resolve(process.cwd(), options.agentDir);
  const requestedPort = parseInt(options.port, 10);

  // Load .env.local from the project root before anything reads env keys.
  // The user puts CENCORI_API_KEY here; if we don't load it, both this
  // process and the spawned `next dev` see nothing.
  loadDotEnv(join(dirname(agentDirPath), ".env.local"));

  if (!process.env.CENCORI_API_KEY) process.env.CENCORI_API_KEY = "local-dev-key";

  showHeader();

  const { diagnostics } = discoverAgent(agentDirPath);
  if (diagnostics.some((d) => d.severity === "error")) {
    for (const d of diagnostics) console.error(`  ${grey("✖")} ${d.code}: ${d.message}`);
    process.exit(1);
  }
  for (const d of diagnostics) console.warn(`  ${grey("⚠")} ${d.code}: ${d.message}`);

  let modelLine = agentDirPath;
  let missingKeys: string[] = [];
  let agentModel = "";
  try {
    const agent = await loadAgent(agentDirPath);
    agentModel = agent.manifest.config.model;
    modelLine = `${agentDirPath} ${grey("\xB7")} ${grey(agent.manifest.config.model)}`;
    missingKeys = checkProviderKeys(agent.manifest.config.model);
  } catch {
    /* fall through — dev still runs, /api/chat will error clearly */
  }
  console.log(`  ${modelLine}`);
  console.log();

  const projectRoot = dirname(agentDirPath);
  const webDir = join(projectRoot, "web");
  const hasWeb = existsSync(webDir);
  const wantsWeb = !options.input && options.noWeb !== true && hasWeb;

  // ── Web-attached mode: one process, one port. Next.js owns /api/chat
  //    and calls streamAgent() in-process. No proxy, no separate arcie HTTP.
  //    Next.js also owns web port selection — the requested port is a hint,
  //    and we report whatever it actually bound.
  if (wantsWeb) {
    const engine = await chooseEngine(agentModel);
    if (engine.mode === "local" || engine.mode === "failover") {
      const started = await startLocalGateway();
      if (started) {
        process.env.CENCORI_API_URL = started;
      } else {
        engine.mode = "cloud";
      }
    }
    console.log(`  ${dimmed(`engine ${grey("\xB7")} ${describeEngine(engine)}`)}`);
    if (engine.mode === "failover") {
      console.log(`  ${grey("!")} cencori.com unreachable ${grey("\xB7")} failing over to local ${engine.provider} until it's back`);
    }
    if (engine.mode === "cloud-unreachable") {
      console.log(`  ${grey("⚠")} cencori.com is unreachable — requests will fail until it recovers`);
      console.log(`  ${dimmed(`  (set ${engine.provider ? providerKeyName(engine.provider) : "a provider key"} in .env.local to fail over locally)`)}`);
    }

    console.log(`  ${dimmed(`starting on http://localhost:${requestedPort}…`)}`);
    const webChannel = await startWebChannel(agentDirPath, requestedPort);
    if (webChannel === undefined) {
      console.log(`  ${grey("⚠")} web channel failed to start`);
      process.exit(1);
    }
    const boundPortMatch = webChannel.url.match(/:(\d+)$/);
    if (boundPortMatch && boundPortMatch[1] !== String(requestedPort)) {
      console.log(`  ${grey("!")} port ${requestedPort} was in use ${grey("\xB7")} next chose ${boundPortMatch[1]}`);
    }
    console.log(`  ${dimmed(`web    ${webChannel.url}`)}`);
    console.log(`  ${dimmed(`api    ${webChannel.url}/api/chat`)}`);
    // Provider keys are only the user's problem in BYOK mode — with a
    // Cencori key, models come from Cencori and no other key is needed.
    console.log();
    console.log(`  ${dimmed("set CENCORI_API_KEY to use Cencori models")}`);
    console.log();
    console.log(`  ${dimmed("hot reload  edits to agent/*.ts land on the next request")}`);
    console.log();
    console.log(`  ${dimmed("Ctrl+C to stop")}`);
    console.log();

    if (options.noOpen !== true) openBrowser(webChannel.url);

    const watcher = startAgentWatcher(agentDirPath);
    const shutdown = () => {
      watcher?.close();
      webChannel.process.kill();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  // ── JSON-only mode: no web/. Standalone HTTP server for
  //    curl users, tests, and other connectors that hit the agent
  //    directly (Slack, WhatsApp bots, etc. down the line).
  const streamTurn = async (
    res: import("node:http").ServerResponse,
    body: string,
    agentId: string | undefined,
  ) => {
    try {
      const { message, stream } = JSON.parse(body);
      if (typeof message !== "string" || message.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "message is required" }));
        return;
      }
      const runOpts = {
        hotReload: true,
        ...(agentId !== undefined ? { agentId } : {}),
      };
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for await (const event of streamAgent(agentDirPath, message, runOpts)) {
          res.write(JSON.stringify(event) + "\n");
        }
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        for await (const _event of streamAgent(agentDirPath, message, runOpts)) {}
        res.end(JSON.stringify({ status: "ok" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  };

  const listAgents = async () => {
    const discovered = discoverAgents(agentDirPath);
    return Promise.all(
      discovered.map(async ({ id }) => {
        try {
          const loaded = await loadAgentById(agentDirPath, id, { hotReload: true });
          const { config } = loaded.manifest;
          return {
            id,
            name: config.name ?? id,
            model: config.model,
            description: config.description ?? "",
          };
        } catch {
          return { id, name: id, model: "", description: "" };
        }
      }),
    );
  };

  const server = createServer(async (req, res) => {
    if (await handleSessionsRequest(req, res)) return;

    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === "/agents") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await listAgents()));
      return;
    }

    const agentsMatch = url.match(/^\/agents\/([^/?]+)(?:\?.*)?$/);
    if (method === "POST" && agentsMatch !== null) {
      let body = "";
      for await (const chunk of req) body += chunk;
      await streamTurn(res, body, decodeURIComponent(agentsMatch[1]!));
      return;
    }

    if (method === "POST" && url === "/") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await streamTurn(res, body, undefined);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  let boundPort: number;
  try {
    boundPort = await listenWithFallback(server, requestedPort);
  } catch (err) {
    console.error();
    console.error(`  ${grey("✗")} ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  ${dimmed("try: arcie dev --port <n>    # pick your own starting port")}`);
    console.error();
    process.exit(1);
  }

  // Same engine contract as web mode: a Cencori key means Cencori
  // models — this process's built-in gateway only serves the loop in
  // BYOK mode or as failover when cencori.com is unreachable.
  const jsonEngine = await chooseEngine(agentModel);
  if (!process.env.CENCORI_API_URL && (jsonEngine.mode === "local" || jsonEngine.mode === "failover")) {
    process.env.CENCORI_API_URL = `http://127.0.0.1:${boundPort}/v1`;
  }
  console.log(`  ${dimmed(`engine ${grey("\xB7")} ${describeEngine(jsonEngine)}`)}`);
  if (jsonEngine.mode === "failover") {
    console.log(`  ${grey("!")} cencori.com unreachable ${grey("\xB7")} failing over to local ${jsonEngine.provider} until it's back`);
  }
  if (jsonEngine.mode === "cloud-unreachable") {
    console.log(`  ${grey("⚠")} cencori.com is unreachable — requests will fail until it recovers`);
  }

  if (boundPort !== requestedPort) {
    console.log(`  ${grey("!")} port ${requestedPort} was in use ${grey("\xB7")} using ${boundPort}`);
    console.log();
  }
  console.log(`  ${dimmed(`agent  http://localhost:${boundPort}`)}`);
  console.log();
  console.log(`  ${dimmed("set CENCORI_API_KEY to use Cencori models")}`);
  console.log();
  console.log(`  ${dimmed("hot reload  edits to agent/*.ts land on the next request")}`);
  console.log();
  console.log(`  ${dimmed("Ctrl+C to stop")}`);
  console.log();

  const watcher = startAgentWatcher(agentDirPath);
  const shutdown = () => {
    watcher?.close();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (options.input) {
    void startBlockChat({ agentDir: agentDirPath });
  }
}

/**
 * Watches the agent directory for `.ts` / `.md` changes and logs which files
 * changed. Actual hot-reload happens in the loader (cache-busted import per
 * request) — the watcher is purely informational.
 */
function startAgentWatcher(agentDirPath: string): FSWatcher | undefined {
  try {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    return watch(agentDirPath, { recursive: true }, (_event, filename) => {
      if (typeof filename !== "string") return;
      if (!filename.endsWith(".ts") && !filename.endsWith(".md")) return;
      seen.add(filename);
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const files = [...seen].sort();
        seen.clear();
        for (const file of files) {
          console.log(`  ${dimmed(`reload · ${file}`)}`);
        }
      }, 150);
    });
  } catch {
    return undefined;
  }
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* ignore */
  }
}
