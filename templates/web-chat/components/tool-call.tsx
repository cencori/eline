"use client";

import * as React from "react";
import {
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FileText,
  ImageIcon,
  Loader2,
  XCircle,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiToolCall } from "@/lib/types";

function formatJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const TOOL_LABELS: Record<string, string> = {
  document_extract: "Read document",
  document_query: "Query document",
  document_summarize: "Summarize document",
  fetch_url: "Read page",
  file_reader: "Read file",
  grep: "Search files",
  search_docs: "Search documentation",
  vision_analyze: "Analyze image",
  vision_classify: "Classify image",
  vision_ocr: "Read image text",
  web_search: "Search the web",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replaceAll("_", " ");
}

function summarize(input: unknown, max = 60): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return String(input).slice(0, max);
  if (Array.isArray(input)) return `[${input.length} items]`;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts = entries.map(([key, value]) => {
    if (typeof value === "string") return `${key}="${value.slice(0, 24)}"`;
    if (typeof value === "object") {
      return `${key}=${Array.isArray(value) ? `[${value.length} items]` : "{…}"}`;
    }
    return `${key}=${String(value)}`;
  });
  const joined = parts.join(", ");
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

function resultText(call: UiToolCall): string | undefined {
  if (call.status === "error") return call.errorMessage;
  if (call.status === "denied") return "denied by user";
  if (call.status === "approval") return call.errorMessage ?? "awaiting approval";
  if (call.output === undefined || call.output === null) return undefined;
  if (typeof call.output === "string") {
    try {
      const parsed = JSON.parse(call.output) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.count === "number") {
          return record.count === 0
            ? "No documentation match"
            : `${record.count} result${record.count === 1 ? "" : "s"}`;
        }
      }
    } catch {
      // Non-JSON output falls through to its first useful line.
    }
    return call.output.split("\n").find((line) => line.trim().length > 0) ?? undefined;
  }
  if (typeof call.output !== "object") return String(call.output);
  const record = call.output as Record<string, unknown>;
  for (const key of ["result", "text", "message", "summary", "value", "output"]) {
    const value = record[key];
    if (value !== undefined && typeof value !== "object") return String(value);
  }
  return undefined;
}

interface ToolCallProps {
  call: UiToolCall;
  onApprove?(): void;
  onDeny?(): void;
}

export function ToolCall({ call, onApprove, onDeny }: ToolCallProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState<"input" | "output" | null>(null);
  const args = summarize(call.input);
  const result = resultText(call);
  const awaitingApproval = call.status === "approval";
  const hasDetail = call.input !== undefined || call.output !== undefined;

  const copyJSON = (label: "input" | "output", value: unknown) => {
    void navigator.clipboard.writeText(formatJSON(value));
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1200);
  };

  const statusColor = {
    running: "text-muted-foreground",
    done: "text-emerald-500",
    error: "text-destructive",
    approval: "text-amber-500",
    denied: "text-muted-foreground",
  }[call.status];

  return (
    <div
      className={cn(
        "group rounded-xl border bg-card/40 text-xs transition-all duration-200",
        awaitingApproval
          ? "border-amber-500/30 shadow-[0_0_12px_-4px_hsl(var(--primary))]"
          : "border-border/30 hover:border-border/50",
        expanded && "border-border/50",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={statusColor}>
          <StatusGlyph status={call.status} />
        </span>
        {hasDetail && (
          <span className="text-muted-foreground/50 transition-transform duration-150">
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
        )}
        <span className="font-semibold text-[11px] tracking-[-0.01em]">{toolLabel(call.name)}</span>
        {call.kind === "subagent" && (
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
            <Bot className="h-2.5 w-2.5" />
            agent
          </span>
        )}
        {args.length > 0 && !expanded && (
          <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/50 max-w-[200px]">
            {args}
          </span>
        )}
      </button>

      {result !== undefined && !expanded && (
        <div className="ml-8 mr-3 pb-2 truncate text-[10px] text-muted-foreground/50">
          → <span className="font-mono">{result}</span>
        </div>
      )}

      {awaitingApproval && onApprove && onDeny && (
        <div className="ml-8 mr-3 pb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            className="rounded-lg bg-emerald-600/80 px-3 py-1 text-[10px] font-semibold text-white transition-all hover:bg-emerald-600 active:scale-[0.97]"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeny(); }}
            className="rounded-lg border border-border/40 px-3 py-1 text-[10px] font-medium text-muted-foreground transition-all hover:bg-muted/30 hover:text-foreground active:scale-[0.97]"
          >
            Deny
          </button>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border/20 px-3 py-2.5 space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-150">
          {call.input !== undefined && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                  Input
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); copyJSON("input", call.input); }}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                >
                  {copied === "input" ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-2.5 text-[10px] leading-relaxed text-muted-foreground/80 font-mono">
                {formatJSON(call.input)}
              </pre>
            </div>
          )}
          {(call.output !== undefined && call.status !== "error") && (
            <SmartOutput name={call.name} output={call.output} onCopy={(v) => copyJSON("output", v)} />
          )}
          {call.status === "error" && call.errorMessage && (
            <div className="rounded-lg bg-destructive/5 p-2.5 text-[10px] text-destructive font-mono">
              {call.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusGlyph({ status }: { status: UiToolCall["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    case "done":
      return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "error":
      return <XCircle className="h-3.5 w-3.5" />;
    case "approval":
      return <HelpCircle className="h-3.5 w-3.5" />;
    case "denied":
      return <Ban className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

const DOCUMENT_TOOLS = new Set([
  "document_extract", "document_summarize", "document_query",
  "vision_analyze", "vision_ocr", "vision_classify",
]);

const DISPLAY_FIELDS = ["analysis", "text", "summary", "answer", "classification"];

function SmartOutput({ name, output, onCopy: onCopyProp }: { name: string; output: unknown; onCopy: (v: unknown) => void }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = (value: unknown) => {
    onCopyProp(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  if (!DOCUMENT_TOOLS.has(name) || typeof output !== "object" || output === null) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
            Output
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCopy(output); }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-2.5 text-[10px] leading-relaxed text-muted-foreground/80 font-mono">
          {formatJSON(output)}
        </pre>
      </div>
    );
  }

  const record = output as Record<string, unknown>;
  const primary = DISPLAY_FIELDS.find((k) => typeof record[k] === "string" && (record[k] as string).length > 0);
  const icon = name.startsWith("vision") ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {icon}
          {name.startsWith("vision") ? "Vision Result" : "Document Result"}
        </span>
        <div className="flex items-center gap-2">
          {typeof record.pageCount === "number" && (
            <span className="text-[10px] text-muted-foreground/40">{record.pageCount} page{record.pageCount !== 1 ? "s" : ""}</span>
          )}
          {typeof record.cost === "number" && (
            <span className="text-[10px] text-muted-foreground/40">${record.cost.toFixed(6)}</span>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCopy(output); }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>
      {primary && (
        <div className="rounded-lg bg-muted/10 p-2.5 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {String(record[primary]).slice(0, 2000)}
          {String(record[primary]).length > 2000 && "..."}
        </div>
      )}
    </div>
  );
}
