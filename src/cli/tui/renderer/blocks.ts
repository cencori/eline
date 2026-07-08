import { renderMarkdown } from "../markdown";
import type { Theme } from "../theme";
import { isPromptControlCommand } from "../prompt-commands";
import { formatValuePretty, truncate } from "../tool-format";
import { sliceVisible, visibleLength, wrapVisibleLine } from "../../ui/terminal-text";

export type ToolStatus = "running" | "done" | "error" | "denied" | "approval";

export type BlockKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "error"
  | "notice"
  | "warning"
  | "result"
  | "command"
  | "subagent"
  | "subagent-step"
  | "subagent-tool"
  | "agent-header";

export interface Block {
  kind: BlockKind;
  id?: string;
  depth?: number;
  live?: boolean;

  title?: string;
  subtitle?: string;
  body?: string;
  reasoning?: string;
  result?: string;
  detail?: string;

  status?: ToolStatus;
  preformatted?: boolean;
  collapsed?: boolean;
  expanded?: boolean;
  toolInput?: unknown;
  toolOutput?: unknown;
}

export interface RenderBlockContext {
  spinner: string;
  previous?: { kind: BlockKind; title?: string };
}

export function renderBlockLines(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const depth = block.depth ?? 0;
  const prefix = nestingPrefix(depth, theme);
  const avail = Math.max(8, width - visibleLength(prefix));
  const rows = renderBody(block, avail, theme, context);
  return rows.map((row) => `${prefix}${row}`);
}

function nestingPrefix(depth: number, theme: Theme): string {
  if (depth <= 0) return "";
  const rule = `${theme.colors.orange(theme.glyph.rule)} `;
  return rule.repeat(depth);
}

function renderBody(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  switch (block.kind) {
    case "user":
      return renderUser(block, width, theme);
    case "assistant":
    case "subagent-step":
      return renderProse(block, width, theme);
    case "reasoning":
      return renderReasoning(block, width, theme);
    case "tool":
    case "subagent-tool":
      return renderTool(block, width, theme, context);
    case "error":
      return renderError(block, width, theme);
    case "notice":
      return renderNotice(block, width, theme);
    case "warning":
      return renderWarning(block, width, theme);
    case "result":
      return renderResult(block, width, theme);
    case "command":
      return renderCommand(block, theme);
    case "subagent":
      return renderSubagentHeader(block, width, theme);
    case "agent-header":
      return (block.body ?? "").split("\n");
  }
}

function renderUser(block: Block, width: number, theme: Theme): string[] {
  const bar = theme.colors.cyan(theme.glyph.user);
  const lines = wrap(block.body ?? "", width - 2);
  return lines.map((line) => `${bar} ${line}`);
}

function renderProse(block: Block, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  const isSubagent = block.kind === "subagent-step";
  const glyph = isSubagent ? "" : `${theme.colors.bold(theme.colors.white(theme.glyph.brand))} `;
  const indent = isSubagent ? "" : "  ";

  if (block.reasoning && block.reasoning.trim().length > 0) {
    rows.push(...renderReasoningLines(block.reasoning, width, theme));
  }

  const body = (block.body ?? "").trim();
  if (body.length === 0 && rows.length === 0) {
    return [`${glyph}${theme.colors.dim(`thinking${theme.glyph.ellipsis}`)}`];
  }

  if (body.length > 0) {
    const rendered = renderMarkdown(body)
      .split("\n")
      .flatMap((line) => wrapVisibleLine(line, width - indent.length));
    rendered.forEach((line, index) => {
      if (index === 0 && !isSubagent && rows.length === 0) {
        rows.push(`${glyph}${line}`);
      } else {
        rows.push(`${indent}${line}`);
      }
    });
  }

  return rows.length > 0 ? rows : [`${glyph}`];
}

function renderReasoning(block: Block, width: number, theme: Theme): string[] {
  if (block.collapsed) {
    return [`${theme.colors.gray(theme.glyph.reasoning)} ${theme.colors.dim("thinking")}`];
  }
  return renderReasoningLines(block.body ?? "", width, theme, theme.glyph.reasoning);
}

function renderReasoningLines(
  text: string,
  width: number,
  theme: Theme,
  glyph?: string,
): string[] {
  const pad = glyph ? 2 : 0;
  const lines = wrap(text.trim(), width - pad);
  if (lines.length === 0) return [];
  return lines.map((line, index) => {
    const prefix = glyph ? (index === 0 ? `${theme.colors.gray(glyph)} ` : "  ") : "";
    return `${prefix}${theme.colors.dim(theme.colors.italic(line))}`;
  });
}

function renderTool(
  block: Block,
  width: number,
  theme: Theme,
  context: RenderBlockContext,
): string[] {
  const { icon, accent } = toolGlyph(block.status ?? "running", theme, context);
  const name = block.title ?? "tool";
  const headerWidth = width - 2;
  const namePlain = truncatePlain(name, headerWidth);
  let header = `${icon} ${theme.colors.bold(namePlain)}`;
  const argsBudget = headerWidth - namePlain.length - 2;
  const args = block.subtitle ?? "";
  if (args.length > 0 && argsBudget >= 6) {
    header += `  ${theme.colors.gray(truncate(args, argsBudget))}`;
  }

  const rows = [header];

  if (block.expanded) {
    rows.push(...renderToolExpanded(block, width, theme));
  } else if (block.status === "done" && block.result && block.result.length > 0) {
    rows.push(resultLine(theme.glyph.arrow, block.result, width, theme, accent));
  } else if (block.status === "error" && block.result) {
    rows.push(resultLine(theme.glyph.arrow, block.result, width, theme, theme.colors.red));
  } else if (block.status === "denied") {
    rows.push(resultLine(theme.glyph.arrow, "denied", width, theme, theme.colors.yellow));
  }

  return rows;
}

function renderToolExpanded(block: Block, width: number, theme: Theme): string[] {
  const rows: string[] = [];
  const push = (label: string, value: unknown, color: (text: string) => string) => {
    if (value === undefined) return;
    rows.push(`  ${theme.colors.dim(label)}`);
    for (const line of wrap(formatValuePretty(value), width - 4)) {
      rows.push(`    ${color(line)}`);
    }
  };
  push("input", block.toolInput, theme.colors.gray);
  if (block.status === "error" && block.result) {
    push("error", block.result, theme.colors.red);
  } else {
    push("output", block.toolOutput, theme.colors.gray);
  }
  return rows;
}

function resultLine(
  marker: string,
  text: string,
  width: number,
  theme: Theme,
  color: (text: string) => string,
): string {
  const budget = width - 4;
  return `  ${theme.colors.dim(marker)} ${color(truncate(text, budget))}`;
}

function toolGlyph(
  status: ToolStatus,
  theme: Theme,
  context: RenderBlockContext,
): { icon: string; accent: (text: string) => string } {
  switch (status) {
    case "done":
      return { icon: theme.colors.green(theme.glyph.success), accent: theme.colors.gray };
    case "error":
      return { icon: theme.colors.red(theme.glyph.error), accent: theme.colors.red };
    case "denied":
      return { icon: theme.colors.yellow(theme.glyph.warning), accent: theme.colors.yellow };
    case "approval":
      return { icon: theme.colors.yellow(theme.glyph.question), accent: theme.colors.yellow };
    case "running":
    default:
      return { icon: theme.colors.yellow(context.spinner), accent: theme.colors.gray };
  }
}

const ERROR_DETAIL_MAX_LINES = 12;

function renderError(block: Block, width: number, theme: Theme): string[] {
  const icon = theme.colors.red(theme.colors.bold(theme.glyph.error));
  const title = block.title ?? "Error";
  const rows = [`${icon} ${theme.colors.red(theme.colors.bold(title))}`];
  for (const line of wrap(block.body ?? "", width - 2)) {
    rows.push(`  ${colorizeError(line, theme)}`);
  }
  rows.push(...renderErrorDetail(block.detail, width, theme));
  return rows;
}

function renderErrorDetail(detail: string | undefined, width: number, theme: Theme): string[] {
  if (detail === undefined || detail.trim().length === 0) return [];
  const lines = detail.split("\n");
  const visible = lines.slice(0, ERROR_DETAIL_MAX_LINES);
  const rows = visible.map(
    (line) => `  ${theme.colors.dim(truncatePlain(line, Math.max(1, width - 2)))}`,
  );
  const hidden = lines.length - visible.length;
  if (hidden > 0) {
    rows.push(
      `  ${theme.colors.dim(`${theme.glyph.ellipsis} +${hidden} more line${hidden === 1 ? "" : "s"}`)}`,
    );
  }
  return rows;
}

const URL_PATTERN = /(https?:\/\/\S+)/u;

function colorizeError(line: string, theme: Theme): string {
  if (!URL_PATTERN.test(line)) return theme.colors.red(line);
  return line
    .split(URL_PATTERN)
    .map((segment, index) =>
      index % 2 === 1 ? theme.colors.cyan(segment) : theme.colors.red(segment),
    )
    .join("");
}

function renderNotice(block: Block, width: number, theme: Theme): string[] {
  const marker = theme.colors.dim(theme.glyph.dot);
  const lines = wrap(block.body ?? "", width - 2);
  if (lines.length === 0) return [marker];
  return lines.map((line) => `${marker} ${theme.colors.dim(line)}`);
}

export function renderAttentionRows(body: string, width: number, theme: Theme): string[] {
  const marker = theme.colors.yellow(theme.glyph.warning);
  const lines = wrap(body, width - 2);
  return lines.map((line, index) => `${index === 0 ? marker : " "} ${paintCommands(line, theme)}`);
}

function renderWarning(block: Block, width: number, theme: Theme): string[] {
  return renderAttentionRows(block.body ?? "", width, theme);
}

function paintCommands(line: string, theme: Theme): string {
  return line.replace(/\/[a-z:-]+/g, (token) =>
    isPromptControlCommand(token) ? theme.colors.blue(token) : token,
  );
}

/**
 * A slash-command invocation echoed under the user gutter. Rendered blue
 * so it's obvious it's a system-directed action, not chat content, but
 * marked with the same `▌` glyph as user messages so it visually chains
 * with the transcript. Failed commands (status: "error") get a leading `⨯`.
 */
function renderCommand(block: Block, theme: Theme): string[] {
  const c = theme.colors;
  const status = block.status === "error" ? `${c.red(theme.glyph.error)} ` : "";
  return [`${c.cyan(theme.glyph.user)} ${status}${c.blue(block.body ?? "")}`];
}

function renderResult(block: Block, width: number, theme: Theme): string[] {
  const marker = theme.colors.dim(theme.glyph.elbow);
  const lines = wrap(block.body ?? "", width - 7);
  if (lines.length === 0) return [`   ${marker}`];
  const dim = (line: string): string =>
    theme.colors.dim(line.replaceAll("\x1b[22m", "\x1b[22m\x1b[2m"));
  return lines.map((line, index) =>
    index === 0 ? `   ${marker}  ${dim(line)}` : `      ${dim(line)}`,
  );
}

function renderSubagentHeader(block: Block, width: number, theme: Theme): string[] {
  const name = truncatePlain(block.title ?? "subagent", Math.max(8, width - 14));
  return [
    `${theme.colors.orange(theme.glyph.subagent)} ${theme.colors.bold(name)} ${theme.colors.dim("subagent")}`,
  ];
}

function wrap(text: string, width: number): string[] {
  if (text.trim().length === 0) return [];
  return text.split("\n").flatMap((line) => wrapVisibleLine(line, Math.max(1, width)));
}

function truncatePlain(text: string, maxWidth: number): string {
  if (visibleLength(text) <= maxWidth) return text;
  return sliceVisible(text, maxWidth);
}
