#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { arcieCliBanner, version } from "./banner";
import { createCliTheme, renderCliTaggedLine } from "./ui/output";

interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

const DISPLAY_MODES = new Set(["full", "collapsed", "auto-collapsed", "hidden"]);
const STATS_MODES = new Set(["tokens", "tokensPerSecond"]);
const LOG_MODES = new Set(["all", "stderr", "none"]);

type TerminalPartDisplayMode = "full" | "collapsed" | "auto-collapsed" | "hidden";
type AssistantResponseStatsMode = "tokens" | "tokensPerSecond";
type LogDisplayMode = "all" | "stderr" | "none";

function parsePortOption(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(`Expected a numeric port, received "${value}".`);
  }
  const port = Number(value);
  if (port < 0 || port > 65_535) {
    throw new InvalidArgumentError(`Expected a port between 0 and 65535, received "${value}".`);
  }
  return port;
}

function parseDisplayMode(value: string): TerminalPartDisplayMode {
  if (!DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }
  return value as TerminalPartDisplayMode;
}

function parseStatsMode(value: string): AssistantResponseStatsMode {
  if (!STATS_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...STATS_MODES].join(", ")}, received "${value}".`,
    );
  }
  return value as AssistantResponseStatsMode;
}

function parseLogsMode(value: string): LogDisplayMode {
  if (!LOG_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...LOG_MODES].join(", ")}, received "${value}".`,
    );
  }
  return value as LogDisplayMode;
}

function parseContextSizeOption(value: string): number {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, received "${value}".`);
  }
  return size;
}

function shouldPrintCliBootBanner(actionCommand: Command): boolean {
  const name = actionCommand.name();
  return name === "info" || name === "dev" || name === "init";
}

function createCliProgram(logger: CliLogger): Command {
  const program = new Command();
  const theme = createCliTheme();

  program
    .name("arcie")
    .description("arcie — the electronic line, build agents at the speed of light")
    .version(version())
    .showHelpAfterError()
    .exitOverride()
    .hook("preAction", (_program, actionCommand) => {
      if (shouldPrintCliBootBanner(actionCommand)) {
        logger.log(arcieCliBanner());
      }
    })
    .configureOutput({
      writeErr: (message) => logger.error(message.trimEnd()),
      writeOut: (message) => logger.log(message.trimEnd()),
    });

  const channels = program
    .command("channels")
    .description("Manage channels for the current agent (web UI, HTTP, etc.).");

  channels
    .command("add <kind>")
    .description("Scaffold a channel (currently supports: web).")
    .option("--agent-dir <path>", "Path to agent directory", ".")
    .action(async (kind: string, options: { agentDir: string }) => {
      if (kind !== "web") {
        logger.error(`unknown channel kind: ${kind}. supported: web`);
        process.exit(1);
      }
      const agentDir = resolvePath(process.cwd(), options.agentDir);
      const { scaffoldWebChat } = await import("./scaffold-web-chat");
      try {
        const result = scaffoldWebChat(agentDir);
        if (result.alreadyExisted) {
          logger.error(`web already exists at ${result.targetPath}`);
          process.exit(1);
        }
        logger.log(
          renderCliTaggedLine(theme, {
            message: `scaffolded ${result.targetPath}`,
            tag: "channels",
            tone: "success",
          }),
        );
        logger.log(
          renderCliTaggedLine(theme, {
            message: "cd into it, then: npm install && cp .env.local.example .env.local && npm run dev",
            tag: "next",
            tone: "info",
          }),
        );
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command("init [target]")
    .description("Create a new arcie agent, or add one to an existing project directory.")
    .option("--template <name>", "Template to use (default, agent-only)", "default")
    .option("-y, --yes", "Accepted for compatibility; has no effect")
    .action(async (target: string | undefined, options: { template: string; yes?: boolean }) => {
      if (options.yes) logger.error("warning: --yes has no effect for arcie init.");
      const { initCommand } = await import("./init");
      await initCommand(target, { template: options.template });
    });

  program
    .command("build")
    .description("Compile the agent for production.")
    .option("--agent-dir <path>", "Path to agent directory", "agent")
    .option("--out-dir <path>", "Output directory", ".arcie")
    .action(async (options: { agentDir: string; outDir: string }) => {
      const { buildCommand } = await import("./build");
      await buildCommand(options);
      logger.log(
        renderCliTaggedLine(theme, {
          message: `output at ${options.outDir}`,
          tag: "build",
          tone: "success",
        }),
      );
    });

  program
    .command("dev")
    .description("Start the arcie development server or attach an interactive UI.")
    .option("-p, --port <port>", "Port to listen on", parsePortOption, 3000)
    .option("--host <host>", "Host interface to bind")
    .option("--agent-dir <path>", "Path to agent directory", "agent")
    .option("--input <text>", "Pre-fill the prompt input, or start onboarding with /model")
    .option("--no-ui", "Start the server without an interactive UI")
    .option("--name <name>", "Title shown in the terminal UI (defaults to the app folder name)")
    .option(
      "--tools <mode>",
      "How tool calls render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--reasoning <mode>",
      "How reasoning renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--subagents <mode>",
      "How subagent sections render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--assistant-response-stats <mode>",
      "Assistant header statistic: tokens | tokensPerSecond",
      parseStatsMode,
    )
    .option(
      "--context-size <tokens>",
      "Model context window size, shown as a usage percentage",
      parseContextSizeOption,
    )
    .option("--logs <mode>", "Which logs to show: all | stderr | none", parseLogsMode)
    .option("--no-web", "Do not auto-start the web/ dev server")
    .option("--no-open", "Do not auto-open the browser at the web channel URL")
    .action(async (options) => {
      const { devCommand } = await import("./dev");
      await devCommand({
        port: String(options.port ?? 3000),
        agentDir: options.agentDir,
        input: options.ui === false ? false : Boolean(options.input),
        noWeb: options.web === false,
        noOpen: options.open === false,
      });
    });

  return program;
}

const KNOWN_COMMANDS = new Set(["channels", "init", "build", "dev", "help"]);

function resolveArgv(argv: readonly string[]): string[] {
  if (argv.length === 0) return ["dev"];
  const first = argv[0]!;
  if (first === "-h" || first === "--help" || first === "-V" || first === "--version") {
    return [...argv];
  }
  if (first.startsWith("-")) return [...argv];
  if (KNOWN_COMMANDS.has(first)) return [...argv];
  // Bare positional like `arcie my-agent` — treat as `arcie init my-agent`.
  return ["init", ...argv];
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  logger: CliLogger = console,
): Promise<void> {
  const program = createCliProgram(logger);
  const input = resolveArgv(argv);

  try {
    await program.parseAsync(input, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      throw new Error(error.message);
    }
    throw error;
  }
}

runCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
