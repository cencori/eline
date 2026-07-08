import type { Block } from "./blocks";
import { renderBlockLines, type RenderBlockContext } from "./blocks";
import { createBlockStore, type BlockOp, type BlockStore } from "./event-to-blocks";
import { LiveRegion, type TerminalOutput } from "./live-region";
import { createTheme, detectUnicode, type Theme } from "../theme";
import {
  EMPTY_LINE,
  PromptHistory,
  applyLineEditorKey,
  type LineState,
  visibleLine,
} from "../line-editor";
import { inputTextWidth, visibleLength } from "../../ui/terminal-text";
import type { TerminalKey } from "../key-parser";
import {
  matchingCommands,
  type PromptCommandSpec,
  PROMPT_COMMANDS,
} from "../prompt-commands";

export interface TerminalRendererOptions {
  readonly output?: TerminalOutput;
  readonly theme?: Theme;
  readonly commands?: readonly PromptCommandSpec[];
  readonly spinnerIntervalMs?: number;
}

interface TypeaheadState {
  readonly matches: readonly PromptCommandSpec[];
  readonly selectedIndex: number;
  readonly dismissed: boolean;
}

const EMPTY_TYPEAHEAD: TypeaheadState = {
  matches: [],
  selectedIndex: 0,
  dismissed: false,
};

/**
 * Terminal-side glue for the block renderer.
 *
 * Owns the LiveRegion, the block store, the line editor's `LineState`, and
 * the slash-command typeahead. External code feeds it stream events via
 * {@link apply} and key presses via {@link handleKey}; the renderer decides
 * when a prompt has been submitted and resolves the pending
 * `readPrompt` promise with its text.
 */
export class TerminalRenderer {
  readonly #output: TerminalOutput;
  readonly #theme: Theme;
  readonly #commands: readonly PromptCommandSpec[];
  readonly #store: BlockStore;
  readonly #region: LiveRegion;
  readonly #history = new PromptHistory();
  readonly #spinnerIntervalMs: number;
  #line: LineState = EMPTY_LINE;
  #typeahead: TypeaheadState = EMPTY_TYPEAHEAD;
  #pendingResolve: ((value: string | undefined) => void) | undefined;
  #spinnerFrame = 0;
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #firstPaintDone = false;

  constructor(options: TerminalRendererOptions = {}) {
    this.#output = options.output ?? (process.stdout as unknown as TerminalOutput);
    this.#theme = options.theme ?? createTheme({ unicode: detectUnicode() });
    this.#commands = options.commands ?? PROMPT_COMMANDS;
    this.#spinnerIntervalMs = options.spinnerIntervalMs ?? 90;
    this.#store = createBlockStore();
    this.#region = new LiveRegion({
      output: this.#output,
      onResize: () => this.#paint(),
    });
  }

  apply(ops: readonly BlockOp[]): void {
    if (ops.length === 0) return;
    for (const op of ops) this.#store.apply(op);
    this.#flushCommitted();
    this.#syncSpinner();
    this.#paint();
  }

  writeNotice(text: string): void {
    this.apply([{ type: "commit", block: { kind: "notice", body: text } }]);
  }

  writeError(title: string, message: string): void {
    this.apply([
      { type: "commit", block: { kind: "error", title, body: message } },
    ]);
  }

  writeAgentHeader(body: string): void {
    this.apply([{ type: "commit", block: { kind: "agent-header", body } }]);
  }

  /**
   * Echoes a slash-command invocation to scrollback so it chains with the
   * transcript above (blue `▌ /model`) and the {@link writeCommandResult}
   * that hangs beneath it can share visual context.
   */
  writeCommandInvocation(text: string, status?: "error"): void {
    const block: Block = { kind: "command", body: text };
    if (status === "error") block.status = "error";
    this.apply([{ type: "commit", block }]);
  }

  /**
   * Writes a command outcome hung under the previous invocation with the
   * elbow connector (`⎿  message`). Multi-line messages soft-wrap under the
   * elbow.
   */
  writeCommandResult(text: string): void {
    this.apply([{ type: "commit", block: { kind: "result", body: text } }]);
  }

  readPrompt(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.#pendingResolve = resolve;
      this.#line = EMPTY_LINE;
      this.#typeahead = EMPTY_TYPEAHEAD;
      this.#history.begin(this.#line.text);
      this.#paint();
    });
  }

  handleKey(key: TerminalKey): void {
    if (this.#pendingResolve === undefined) return;

    if (key.type === "ctrl-c") {
      const resolve = this.#pendingResolve;
      this.#pendingResolve = undefined;
      this.stop();
      resolve(undefined);
      return;
    }

    if (this.#isTypeaheadOpen() && (key.type === "up" || key.type === "down")) {
      const delta = key.type === "up" ? -1 : 1;
      this.#moveTypeahead(delta);
      this.#paint();
      return;
    }

    if (this.#isTypeaheadOpen() && (key.type === "tab" || key.type === "enter")) {
      this.#acceptTypeahead(key.type === "enter");
      return;
    }

    if (key.type === "escape" && this.#isTypeaheadOpen()) {
      this.#typeahead = { ...this.#typeahead, dismissed: true };
      this.#paint();
      return;
    }

    if (key.type === "enter") {
      this.#submit();
      return;
    }

    if (key.type === "up" || key.type === "ctrl-p") {
      const previous = this.#history.previous(this.#line.text);
      if (previous !== undefined) {
        this.#line = { text: previous, cursor: previous.length };
        this.#refreshTypeahead();
        this.#paint();
      }
      return;
    }
    if (key.type === "down" || key.type === "ctrl-n") {
      const next = this.#history.next();
      if (next !== undefined) {
        this.#line = { text: next, cursor: next.length };
        this.#refreshTypeahead();
        this.#paint();
      }
      return;
    }

    const nextLine = applyLineEditorKey(this.#line, key, { multiline: false });
    if (nextLine !== undefined) {
      this.#line = nextLine;
      this.#refreshTypeahead();
      this.#paint();
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#spinnerTimer !== undefined) clearInterval(this.#spinnerTimer);
    this.#region.stop();
  }

  #submit(): void {
    if (this.#pendingResolve === undefined) return;
    const text = this.#line.text;
    this.#history.add(text);
    const resolve = this.#pendingResolve;
    this.#pendingResolve = undefined;
    this.#line = EMPTY_LINE;
    this.#typeahead = EMPTY_TYPEAHEAD;
    this.#region.paint([], { row: 1, col: 1 });
    resolve(text);
  }

  #refreshTypeahead(): void {
    const matches = matchingCommands(this.#commands, this.#line.text);
    this.#typeahead = { matches, selectedIndex: 0, dismissed: false };
  }

  #isTypeaheadOpen(): boolean {
    return this.#typeahead.matches.length > 0 && !this.#typeahead.dismissed;
  }

  #moveTypeahead(delta: number): void {
    const count = this.#typeahead.matches.length;
    if (count === 0) return;
    const selectedIndex = (this.#typeahead.selectedIndex + delta + count) % count;
    this.#typeahead = { ...this.#typeahead, selectedIndex };
  }

  #acceptTypeahead(submitAfter: boolean): void {
    const spec = this.#typeahead.matches[this.#typeahead.selectedIndex];
    if (spec === undefined) return;
    const text = `/${spec.name}${spec.takesArgument ? " " : ""}`;
    this.#line = { text, cursor: text.length };
    this.#typeahead = EMPTY_TYPEAHEAD;
    if (submitAfter && !spec.takesArgument) {
      this.#submit();
    } else {
      this.#paint();
    }
  }

  #flushCommitted(): void {
    const drained = this.#store.drainCommitted();
    if (drained.length === 0) return;
    const rows: string[] = [];
    let previous: RenderBlockContext["previous"] | undefined;
    const ctx: RenderBlockContext = { spinner: this.#currentSpinner(), previous };
    for (const block of drained) {
      const blockCtx: RenderBlockContext = { spinner: this.#currentSpinner(), previous };
      rows.push(...renderBlockLines(block, this.columns, this.#theme, blockCtx));
      previous = { kind: block.kind, title: block.title };
    }
    if (rows.length > 0 && this.#firstPaintDone) rows.unshift("");
    if (!this.#firstPaintDone && rows.length > 0) this.#firstPaintDone = true;
    this.#region.commit(rows);
  }

  #paint(): void {
    if (this.#stopped) return;
    if (this.#pendingResolve === undefined && this.#store.live.size === 0) {
      this.#region.paint([], { row: 1, col: 1 });
      return;
    }

    const rows: string[] = [];
    const ctx: RenderBlockContext = { spinner: this.#currentSpinner() };
    for (const block of this.#store.live.values()) {
      rows.push(...renderBlockLines(block, this.columns, this.#theme, ctx));
    }

    if (this.#pendingResolve !== undefined) {
      if (rows.length > 0) rows.push("");
      const inputRow = this.#renderInputRow();
      const caretCol = this.#caretColumn();
      rows.push(inputRow);
      this.#region.paint(rows, { row: rows.length, col: caretCol });
      return;
    }

    this.#region.paint(rows, { row: rows.length, col: 1 });
  }

  #renderInputRow(): string {
    const c = this.#theme.colors;
    const promptGlyph = c.cyan(this.#theme.glyph.prompt);
    const promptWidth = visibleLength(`${this.#theme.glyph.prompt} `);
    const budget = Math.max(1, this.columns - promptWidth);
    const view = visibleLine(this.#line, budget);
    const before = view.before;
    const under = view.under.length === 0 ? " " : view.under;
    const after = view.after;
    return `${promptGlyph} ${before}${c.inverse(under)}${after}`;
  }

  #caretColumn(): number {
    const promptWidth = visibleLength(`${this.#theme.glyph.prompt} `);
    const view = visibleLine(this.#line, Math.max(1, this.columns - promptWidth));
    return 1 + promptWidth + inputTextWidth(view.before);
  }

  #currentSpinner(): string {
    return this.#theme.spinner[this.#spinnerFrame % this.#theme.spinner.length] ?? "-";
  }

  #syncSpinner(): void {
    const hasLive = [...this.#store.live.values()].some((b) => b.live === true);
    if (hasLive && this.#spinnerTimer === undefined) {
      this.#spinnerTimer = setInterval(() => {
        this.#spinnerFrame += 1;
        this.#paint();
      }, this.#spinnerIntervalMs);
      this.#spinnerTimer.unref?.();
    }
    if (!hasLive && this.#spinnerTimer !== undefined) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
  }

  get columns(): number {
    return this.#region.columns;
  }
}
