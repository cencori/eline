import { watch, type FSWatcher } from "node:fs";
import { streamAgent } from "../../../runner/index";
import { loadAgent } from "../../../loader";
import { discoverAgent } from "../../../discover/index";
import {
  listChannels,
  providerKeyStatus,
  readAgentModel,
  writeAgentModel,
} from "../../agent-config";
import { scaffoldWebChat } from "../../scaffold-web-chat";
import type { PromptCommand } from "../prompt-commands";
import { parsePromptCommand, formatPromptCommandHelp } from "../prompt-commands";
import { attachKeyStream } from "../attach-keys";
import { EventTranslator } from "./event-to-blocks";
import { TerminalRenderer } from "./terminal-renderer";

type ExtensionCommand = Extract<PromptCommand, { type: "extension" }>;
type LoglevelCommand = Extract<PromptCommand, { type: "loglevel" }>;

const VALID_LOG_MODES = new Set(["all", "stderr", "none"]);

export interface StartBlockChatOptions {
  readonly agentDir: string;
  readonly initialInput?: string;
}

/**
 * Runs the block-based dev TUI against a local agent directory. Returns when
 * the user submits `/exit` or presses Ctrl+C. Ownership of raw stdin is
 * scoped to this function; the caller does not need to restore terminal
 * state on exit paths.
 */
export async function startBlockChat(options: StartBlockChatOptions): Promise<void> {
  const { agentDir } = options;
  const renderer = new TerminalRenderer();
  const translator = new EventTranslator();

  const commitHeader = async () => {
    try {
      const agent = await loadAgent(agentDir);
      const model = agent.manifest.config.model;
      renderer.writeAgentHeader(`arcie · ${agentDir.split("/").pop() ?? "agent"} · ${model}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      renderer.writeError("Agent load failed", message);
    }
  };

  const { diagnostics } = discoverAgent(agentDir);
  const errorDiags = diagnostics.filter((d) => d.severity === "error");
  if (errorDiags.length > 0) {
    for (const d of errorDiags) renderer.writeError(d.code, d.message);
    renderer.stop();
    return;
  }

  await commitHeader();

  let watcher: FSWatcher | undefined;
  try {
    let reprobeTimer: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(agentDir, { recursive: true }, () => {
      if (reprobeTimer !== undefined) clearTimeout(reprobeTimer);
      reprobeTimer = setTimeout(() => {
        void commitHeader();
      }, 250);
    });
  } catch {
    // A missing fs.watch (e.g. some sandboxes) is not fatal.
  }

  const detachKeys = attachKeyStream((key) => renderer.handleKey(key));

  const logLevelState = { mode: "none" as "all" | "stderr" | "none" };

  try {
    if (options.initialInput !== undefined && options.initialInput.length > 0) {
      await streamOneTurn(renderer, translator, agentDir, options.initialInput);
    }

    while (true) {
      const text = await renderer.readPrompt();
      if (text === undefined) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const command = parsePromptCommand(trimmed);
        if (command === null) {
          renderer.writeError("Unknown command", `${trimmed} — try /help`);
          continue;
        }
        switch (command.type) {
          case "exit":
            return;
          case "help":
            for (const line of formatPromptCommandHelp().split("\n")) {
              renderer.writeNotice(line);
            }
            continue;
          case "clear":
          case "new":
            for (const op of translator.reset()) renderer.apply([op]);
            await commitHeader();
            continue;
          case "extension":
            await handleExtension(command, renderer, agentDir, commitHeader);
            continue;
          case "loglevel":
            handleLogLevel(command, renderer, logLevelState);
            continue;
        }
        continue;
      }

      await streamOneTurn(renderer, translator, agentDir, trimmed);
    }
  } finally {
    detachKeys();
    watcher?.close();
    renderer.stop();
  }
}

async function handleExtension(
  command: ExtensionCommand,
  renderer: TerminalRenderer,
  agentDir: string,
  commitHeader: () => Promise<void>,
): Promise<void> {
  const argument = command.argument.trim();
  switch (command.name) {
    case "model":
      await handleModel(argument, renderer, agentDir, commitHeader);
      return;
    case "provider":
      handleProvider(renderer, agentDir);
      return;
    case "channels":
      handleChannels(argument, renderer, agentDir);
      return;
    default:
      renderer.writeNotice(`/${command.name} is not supported here`);
  }
}

async function handleModel(
  argument: string,
  renderer: TerminalRenderer,
  agentDir: string,
  commitHeader: () => Promise<void>,
): Promise<void> {
  const current = readAgentModel(agentDir);
  if (argument.length === 0) {
    renderer.writeNotice(
      current ? `current model: ${current}` : "no model configured in agent/agent.ts",
    );
    renderer.writeNotice("change it with: /model <provider/slug>");
    return;
  }
  if (current === argument) {
    renderer.writeNotice(`model is already ${argument}`);
    return;
  }
  const changed = writeAgentModel(agentDir, argument);
  if (!changed) {
    renderer.writeError(
      "Model not changed",
      "Could not update agent/agent.ts — file missing or model field not found.",
    );
    return;
  }
  renderer.writeNotice(`model set to ${argument}`);
  await commitHeader();
}

function handleProvider(renderer: TerminalRenderer, agentDir: string): void {
  const status = providerKeyStatus(agentDir);
  const configured = status.filter((row) => row.set);
  if (configured.length === 0) {
    renderer.writeNotice("no provider keys configured");
    renderer.writeNotice("edit .env.local to add CENCORI_API_KEY or a direct provider key");
    return;
  }
  renderer.writeNotice("provider keys:");
  for (const row of status) {
    if (row.set) {
      renderer.writeNotice(`  ${row.key} = ${row.masked} (${row.source})`);
    } else {
      renderer.writeNotice(`  ${row.key} — not set`);
    }
  }
}

function handleChannels(
  argument: string,
  renderer: TerminalRenderer,
  agentDir: string,
): void {
  if (argument.length === 0) {
    const channels = listChannels(agentDir);
    if (channels.length === 0) {
      renderer.writeNotice("no channels scaffolded");
      renderer.writeNotice("add one with: /channels add web");
      return;
    }
    renderer.writeNotice("channels:");
    for (const channel of channels) renderer.writeNotice(`  ${channel.name} — ${channel.path}`);
    renderer.writeNotice("add another with: /channels add <kind>");
    return;
  }

  const parts = argument.split(/\s+/);
  const subcommand = parts[0];
  const kind = parts[1];
  if (subcommand !== "add") {
    renderer.writeError("Unknown /channels subcommand", `try: /channels add web`);
    return;
  }
  if (kind !== "web") {
    renderer.writeError("Unsupported channel kind", `${kind ?? "(none)"} — only 'web' is supported`);
    return;
  }
  try {
    const result = scaffoldWebChat(agentDir);
    if (result.alreadyExisted) {
      renderer.writeNotice(`channels/web already exists — left it untouched`);
      return;
    }
    renderer.writeNotice(`scaffolded ${result.targetPath}`);
    renderer.writeNotice("next: cd into it, npm install, npm run dev");
  } catch (err) {
    renderer.writeError(
      "Channel scaffold failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function handleLogLevel(
  command: LoglevelCommand,
  renderer: TerminalRenderer,
  state: { mode: "all" | "stderr" | "none" },
): void {
  const argument = command.argument.trim();
  if (argument.length === 0) {
    renderer.writeNotice(`log level: ${state.mode}`);
    renderer.writeNotice("change with: /loglevel all | stderr | none");
    renderer.writeNotice("note: arcie does not currently capture subprocess logs.");
    return;
  }
  if (!VALID_LOG_MODES.has(argument)) {
    renderer.writeError(
      "Invalid log level",
      `${argument} — pick one of: all, stderr, none`,
    );
    return;
  }
  state.mode = argument as "all" | "stderr" | "none";
  renderer.writeNotice(`log level: ${state.mode}`);
  renderer.writeNotice("note: arcie does not currently capture subprocess logs.");
}

async function streamOneTurn(
  renderer: TerminalRenderer,
  translator: EventTranslator,
  agentDir: string,
  message: string,
): Promise<void> {
  let sawApproval = false;
  try {
    for await (const event of streamAgent(agentDir, message)) {
      const ops = translator.feed(event);
      renderer.apply(ops);
      if (
        event.type === "tool.completed" &&
        event.data.status === "pending" &&
        event.data.error?.code === "needs_approval"
      ) {
        sawApproval = true;
      }
    }
    if (sawApproval) {
      renderer.writeNotice(
        "Tool call awaiting approval — approve via the Cencori sessions API to continue.",
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.stack : undefined;
    renderer.apply([
      {
        type: "commit",
        block: {
          kind: "error",
          title: "Stream error",
          body: err instanceof Error ? err.message : String(err),
          detail,
        },
      },
    ]);
  }
}

