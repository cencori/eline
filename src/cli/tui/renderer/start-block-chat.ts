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
          renderer.writeCommandInvocation(trimmed, "error");
          renderer.writeCommandResult("Unknown command — try /help");
          continue;
        }

        if (command.type === "exit") {
          renderer.writeCommandInvocation(trimmed);
          return;
        }

        renderer.writeCommandInvocation(trimmed);

        switch (command.type) {
          case "help":
            renderer.writeCommandResult(formatPromptCommandHelp());
            continue;
          case "clear":
          case "new":
            for (const op of translator.reset()) renderer.apply([op]);
            await commitHeader();
            continue;
          case "extension": {
            const outcome = await handleExtension(command, agentDir);
            if (outcome.message.length > 0) renderer.writeCommandResult(outcome.message);
            if (outcome.refresh) await commitHeader();
            continue;
          }
          case "loglevel": {
            const outcome = handleLogLevel(command, logLevelState);
            renderer.writeCommandResult(outcome.message);
            continue;
          }
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

interface CommandOutcome {
  readonly message: string;
  /** When true, the caller re-commits the agent header (model / manifest changed). */
  readonly refresh?: boolean;
}

async function handleExtension(
  command: ExtensionCommand,
  agentDir: string,
): Promise<CommandOutcome> {
  const argument = command.argument.trim();
  switch (command.name) {
    case "model":
      return handleModel(argument, agentDir);
    case "provider":
      return handleProvider(agentDir);
    case "channels":
      return handleChannels(argument, agentDir);
    default:
      return { message: `/${command.name} is not supported here` };
  }
}

function handleModel(argument: string, agentDir: string): CommandOutcome {
  const current = readAgentModel(agentDir);
  if (argument.length === 0) {
    const lines = [
      current ? `Current model: ${current}` : "No model configured in agent/agent.ts",
      "Change with: /model <provider/slug>",
    ];
    return { message: lines.join("\n") };
  }
  if (current === argument) {
    return { message: `Model is already ${argument}` };
  }
  const changed = writeAgentModel(agentDir, argument);
  if (!changed) {
    return {
      message: "Could not update agent/agent.ts — file missing or model field not found.",
    };
  }
  return { message: `Model set to ${argument}`, refresh: true };
}

function handleProvider(agentDir: string): CommandOutcome {
  const status = providerKeyStatus(agentDir);
  const configured = status.filter((row) => row.set);
  if (configured.length === 0) {
    return {
      message: [
        "No provider keys configured.",
        "Edit .env.local to add CENCORI_API_KEY or a direct provider key.",
      ].join("\n"),
    };
  }
  const lines = ["Provider keys:"];
  for (const row of status) {
    if (row.set) {
      lines.push(`  ${row.key} = ${row.masked} (${row.source})`);
    } else {
      lines.push(`  ${row.key} — not set`);
    }
  }
  return { message: lines.join("\n") };
}

function handleChannels(argument: string, agentDir: string): CommandOutcome {
  if (argument.length === 0) {
    const channels = listChannels(agentDir);
    if (channels.length === 0) {
      return {
        message: ["No channels scaffolded.", "Add one with: /channels add web"].join("\n"),
      };
    }
    const lines = ["Channels:"];
    for (const channel of channels) lines.push(`  ${channel.name} — ${channel.path}`);
    lines.push("Add another with: /channels add <kind>");
    return { message: lines.join("\n") };
  }

  const parts = argument.split(/\s+/);
  const subcommand = parts[0];
  const kind = parts[1];
  if (subcommand !== "add") {
    return { message: `Unknown subcommand '${subcommand}' — try: /channels add web` };
  }
  if (kind !== "web") {
    return {
      message: `Unsupported channel kind '${kind ?? ""}' — only 'web' is supported`,
    };
  }
  try {
    const result = scaffoldWebChat(agentDir);
    if (result.alreadyExisted) {
      return { message: `channels/web already exists at ${result.targetPath}` };
    }
    return {
      message: [
        `Scaffolded ${result.targetPath}`,
        "Next: cd into it, npm install, npm run dev",
      ].join("\n"),
    };
  } catch (err) {
    return {
      message: `Channel scaffold failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function handleLogLevel(
  command: LoglevelCommand,
  state: { mode: "all" | "stderr" | "none" },
): CommandOutcome {
  const argument = command.argument.trim();
  if (argument.length === 0) {
    return {
      message: [
        `Log level: ${state.mode}`,
        "Change with: /loglevel all | stderr | none",
        "Note: arcie does not currently capture subprocess logs.",
      ].join("\n"),
    };
  }
  if (!VALID_LOG_MODES.has(argument)) {
    return { message: `Invalid log level '${argument}' — pick one of: all, stderr, none` };
  }
  state.mode = argument as "all" | "stderr" | "none";
  return {
    message: [
      `Log level: ${state.mode}`,
      "Note: arcie does not currently capture subprocess logs.",
    ].join("\n"),
  };
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

