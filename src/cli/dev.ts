import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAgents, loadAgent, loadAgentById } from "../loader";
import { discoverAgent } from "../discover/index";
import { streamAgent } from "../runner/index";
import { showHeader } from "./banner";
import { grey, dimmed } from "./style";
import { startBlockChat } from "./tui/renderer/start-block-chat";
import { handleSessionsRequest, getProviderApiKey } from "../server/index";

export interface DevOptions {
  port: string;
  agentDir: string;
  input?: boolean;
  /** Skip auto-starting the channels/web/ dev server even when it exists. */
  noWeb?: boolean;
  /** Skip auto-opening the browser at the web channel URL. */
  noOpen?: boolean;
}

function checkProviderKeys(modelId: string): string[] {
  const provider = modelId.split("/")[0];
  const missing: string[] = [];

  const keyMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    mistral: "MISTRAL_API_KEY",
    google: "GOOGLE_API_KEY",
    meta: "TOGETHER_API_KEY",
  };

  const envVar = keyMap[provider];
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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

async function findFreePort(startPort: number, maxAttempts = MAX_PORT_ATTEMPTS): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in ${startPort}..${startPort + maxAttempts - 1}`);
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
 * Spawns the channels/web/ dev server as a child process, waits for it to
 * come up, and returns a handle the caller can kill on shutdown. Returns
 * undefined when the channel isn't scaffolded, isn't installed, or fails
 * to start in time.
 */
async function startWebChannel(
  agentDir: string,
  arcieUrl: string,
  webPort: number,
): Promise<WebChannelHandle | undefined> {
  const webDir = join(agentDir, "channels", "web");
  if (!existsSync(join(webDir, "package.json"))) return undefined;

  if (!existsSync(join(webDir, "node_modules"))) {
    console.log();
    console.log(`  ${grey("⚠")} channels/web needs deps installed:`);
    console.log(`  ${dimmed(`  cd ${webDir} && npm install`)}`);
    console.log();
    return undefined;
  }

  const child = spawn("npm", ["run", "dev", "--", "--port", String(webPort)], {
    cwd: webDir,
    env: { ...process.env, ARCIE_URL: arcieUrl },
    stdio: "ignore",
    detached: false,
  });

  const url = `http://localhost:${webPort}`;
  const ready = await waitForHttp(url, 45_000);
  if (!ready) {
    console.log();
    console.log(`  ${grey("⚠")} channels/web didn't come up within 45s`);
    child.kill();
    return undefined;
  }

  return { url, process: child };
}

export async function devCommand(options: DevOptions): Promise<void> {
  const agentDirPath = resolve(process.cwd(), options.agentDir);
  const requestedPort = parseInt(options.port, 10);

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
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const runOpts = agentId !== undefined ? { agentId } : {};
        for await (const event of streamAgent(agentDirPath, message, runOpts)) {
          res.write(JSON.stringify(event) + "\n");
        }
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        const runOpts = agentId !== undefined ? { agentId } : {};
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
    const summaries = await Promise.all(
      discovered.map(async ({ id }) => {
        try {
          const loaded = await loadAgentById(agentDirPath, id);
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
    return summaries;
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
      // Route bare POST / to the primary agent for backward compatibility.
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

  const localApiUrl = `http://127.0.0.1:${boundPort}/v1`;
  if (!process.env.CENCORI_API_KEY) process.env.CENCORI_API_KEY = "local-dev-key";
  if (!process.env.CENCORI_API_URL) process.env.CENCORI_API_URL = localApiUrl;

  if (!options.input) {
    showHeader();

    const { diagnostics } = discoverAgent(agentDirPath);

    if (diagnostics.some((d) => d.severity === "error")) {
      for (const d of diagnostics) {
        console.error(`  ${grey("✖")} ${d.code}: ${d.message}`);
      }
      process.exit(1);
    }

    for (const d of diagnostics) {
      console.warn(`  ${grey("⚠")} ${d.code}: ${d.message}`);
    }

    try {
      const agent = await loadAgent(agentDirPath);
      console.log(`  ${agentDirPath} ${grey("\xB7")} ${grey(agent.manifest.config.model)}`);
      console.log();
      if (boundPort !== requestedPort) {
        console.log(
          `  ${grey("!")} port ${requestedPort} was in use ${grey("\xB7")} using ${boundPort}`,
        );
        console.log();
      }
      console.log(`  ${dimmed(`agent  http://localhost:${boundPort}`)}`);

      const missing = checkProviderKeys(agent.manifest.config.model);
      if (missing.length > 0) {
        console.log();
        console.log(`  ${grey("⚠")} Missing API keys: ${missing.join(", ")}`);
        console.log(`  ${dimmed("  Set them in .env.local or your environment")}`);
      }
    } catch {
      console.log(`  ${agentDirPath}`);
      console.log();
      console.log(`  ${dimmed(`agent  http://localhost:${boundPort}`)}`);
    }
  }

  let webChannel: WebChannelHandle | undefined;
  if (!options.input && options.noWeb !== true) {
    const webDir = join(agentDirPath, "channels", "web");
    if (existsSync(webDir)) {
      try {
        const webPort = await findFreePort(3001);
        console.log(`  ${dimmed(`web    starting on http://localhost:${webPort}…`)}`);
        webChannel = await startWebChannel(agentDirPath, `http://localhost:${boundPort}`, webPort);
        if (webChannel !== undefined) {
          console.log(`  ${dimmed(`web    http://localhost:${webPort}`)}`);
          if (options.noOpen !== true) openBrowser(webChannel.url);
        }
      } catch (err) {
        console.log(
          `  ${grey("⚠")} could not start web channel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (!options.input) {
    console.log();
    console.log(`  ${dimmed("Ctrl+C to stop")}`);
    console.log();
  }

  const shutdown = () => {
    if (webChannel !== undefined) webChannel.process.kill();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (options.input) {
    void startBlockChat({ agentDir: agentDirPath });
  }
}
