export type PromptCommandExtensionName = "model" | "provider" | "channels";

export type PromptCommand =
  | { type: "new" }
  | { type: "exit" }
  | { type: "help" }
  | { type: "clear" }
  | { type: "loglevel"; argument: string }
  | { type: "extension"; name: PromptCommandExtensionName; argument: string };

export interface PromptCommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly takesArgument: boolean;
  readonly build: (argument: string) => PromptCommand;
}

const PROMPT_COMMAND_DEFINITIONS = [
  {
    name: "help",
    aliases: [],
    description: "Show available commands",
    takesArgument: false,
    build: () => ({ type: "help" }),
  },
  {
    name: "new",
    aliases: [],
    description: "Start a fresh session",
    takesArgument: false,
    build: () => ({ type: "new" }),
  },
  {
    name: "clear",
    aliases: [],
    description: "Clear the screen",
    takesArgument: false,
    build: () => ({ type: "clear" }),
  },
  {
    name: "model",
    aliases: [],
    description: "Show or change the agent's model",
    argumentHint: "[provider/slug]",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "model", argument }),
  },
  {
    name: "provider",
    aliases: [],
    description: "Show provider API key status",
    takesArgument: false,
    build: () => ({ type: "extension", name: "provider", argument: "" }),
  },
  {
    name: "channels",
    aliases: [],
    description: "List or add chat channels",
    argumentHint: "[add web]",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "channels", argument }),
  },
  {
    name: "loglevel",
    aliases: [],
    description: "Show or hide captured stdout/stderr logs",
    argumentHint: "[all|stderr|none]",
    takesArgument: true,
    build: (argument) => ({ type: "loglevel", argument }),
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Quit the TUI",
    takesArgument: false,
    build: () => ({ type: "exit" }),
  },
] satisfies readonly PromptCommandSpec[];

export const PROMPT_COMMANDS: readonly PromptCommandSpec[] = PROMPT_COMMAND_DEFINITIONS;

export function parsePromptCommand(prompt: string): PromptCommand | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return null;
  for (const spec of PROMPT_COMMANDS) {
    for (const alias of [spec.name, ...spec.aliases]) {
      const token = `/${alias}`;
      if (trimmed === token) return spec.build("");
      if (spec.takesArgument && trimmed.startsWith(`${token} `)) {
        return spec.build(trimmed.slice(token.length).trim());
      }
    }
  }
  return null;
}

export function isPromptControlCommand(prompt: string): boolean {
  return parsePromptCommand(prompt) !== null;
}

export function formatPromptCommandHelp(
  commands: readonly PromptCommandSpec[] = PROMPT_COMMANDS,
): string {
  const entries = commands.map((spec) => {
    const hint = spec.argumentHint === undefined ? "" : ` ${spec.argumentHint}`;
    const aliases = spec.aliases.map((alias) => ` (/${alias})`).join("");
    return { invocation: `/${spec.name}${hint}${aliases}`, description: spec.description };
  });
  const column = Math.max(...entries.map((entry) => entry.invocation.length)) + 2;
  return entries.map((entry) => entry.invocation.padEnd(column) + entry.description).join("\n");
}

export function matchingCommands(
  commands: readonly PromptCommandSpec[],
  text: string,
): readonly PromptCommandSpec[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const rest = text.slice(1);
  return commands.filter((spec) =>
    [spec.name, ...spec.aliases].some((token) => token.startsWith(rest)),
  );
}
