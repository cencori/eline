"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ThinkingOrb } from "thinking-orbs";
import {
  AiBrain01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  BookOpen02Icon,
  Calculator01Icon,
  CheckmarkCircle02Icon,
  Database01Icon,
  File01Icon,
  Globe02Icon,
  Link01Icon,
  Search01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { AssistantArtifact, AssistantSource } from "@/lib/assistant-output";
import type { UiToolCall } from "@/lib/types";
import { ThinkingIndicator } from "@/components/thinking-indicator";

interface ActivityPanelProps {
  artifacts: AssistantArtifact[];
  hasVisibleContent: boolean;
  latencyMs?: number;
  reasoning?: string;
  streaming: boolean;
  toolCalls: UiToolCall[];
  onApprove?(): void;
  onDeny?(): void;
}

type ProcessIcon = typeof AiBrain01Icon;

interface ProcessStep {
  id: string;
  label: string;
  detail?: string;
  icon: ProcessIcon;
  status?: UiToolCall["status"] | "info";
}

function normalizeText(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readableValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return normalizeText(value, 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function toolDetail(call: UiToolCall): string | undefined {
  if (call.errorMessage) return normalizeText(call.errorMessage, 180);

  const input = recordOf(call.input);
  if (input) {
    for (const key of ["query", "prompt", "expression", "url", "path", "file", "name", "input"]) {
      const detail = readableValue(input[key]);
      if (detail) return detail;
    }
  }

  const directInput = readableValue(call.input);
  if (directInput) return directInput;

  const output = recordOf(call.output);
  if (output) {
    if (typeof output.count === "number") {
      return output.count === 0
        ? "No matches found"
        : `${output.count} result${output.count === 1 ? "" : "s"} found`;
    }
    for (const key of ["summary", "message", "result", "value", "text"]) {
      const detail = readableValue(output[key]);
      if (detail) return detail;
    }
  }

  return undefined;
}

function fileResourcePath(call: UiToolCall): string | undefined {
  const records = [recordOf(call.input), recordOf(call.output)];

  for (const record of records) {
    if (!record) continue;
    for (const key of ["path", "file", "filename", "name"]) {
      const path = readableValue(record[key]);
      if (path && path !== "." && path !== "./") return path;
    }
  }

  return undefined;
}

function fileResourceName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function toolPresentation(call: UiToolCall): Omit<ProcessStep, "id" | "detail" | "status"> {
  const active = call.status === "running" || call.status === "approval";
  const name = call.name;

  if (call.kind === "subagent") {
    return {
      label: active ? "Working with another agent" : "Worked with another agent",
      icon: UserGroupIcon,
    };
  }
  if (/web_search/.test(name)) {
    return { label: active ? "Searching the web" : "Searched the web", icon: Globe02Icon };
  }
  if (/search_docs|document_query/.test(name)) {
    return { label: active ? "Searching documents" : "Searched documents", icon: BookOpen02Icon };
  }
  if (/fetch_url/.test(name)) {
    return { label: active ? "Reading a source" : "Read a source", icon: Link01Icon };
  }
  if (/document_|file_reader/.test(name)) {
    return { label: active ? "Reading documents" : "Read documents", icon: File01Icon };
  }
  if (/calculator|calculate/.test(name)) {
    return { label: active ? "Calculating" : "Calculated the result", icon: Calculator01Icon };
  }
  if (/grep|search_files/.test(name)) {
    return { label: active ? "Searching files" : "Searched files", icon: Search01Icon };
  }
  if (/memory_query|past_chat|conversation_search/.test(name)) {
    return { label: active ? "Searching memory" : "Checked memory", icon: Database01Icon };
  }
  if (/vision_/.test(name)) {
    return { label: active ? "Analyzing an image" : "Analyzed an image", icon: AiBrain01Icon };
  }
  if (/current_time/.test(name)) {
    return { label: active ? "Checking the time" : "Checked the time", icon: AiBrain01Icon };
  }

  const readableName = name.replaceAll("_", " ");
  return {
    label: active ? readableName : `Completed ${readableName}`,
    icon: AiBrain01Icon,
  };
}

function artifactPresentation(
  artifact: AssistantArtifact,
  index: number,
): ProcessStep {
  const icon = {
    query: Search01Icon,
    results: Globe02Icon,
    source: Link01Icon,
    document: BookOpen02Icon,
  }[artifact.kind];

  return {
    id: `artifact-${artifact.kind}-${index}`,
    label: artifact.label,
    detail: artifact.detail ? normalizeText(artifact.detail, 180) : undefined,
    icon,
    status: "info",
  };
}

function formatDuration(latencyMs?: number): string {
  if (latencyMs === undefined) return "Thought through the request";
  const seconds = Math.max(1, Math.round(latencyMs / 1000));
  return `Thought for ${seconds}s`;
}

function uniqueSources(artifacts: AssistantArtifact[]): AssistantSource[] {
  const seen = new Set<string>();
  return artifacts.flatMap((artifact) => artifact.sources ?? []).filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function ProcessTimeline({
  steps,
  streaming,
  latencyMs,
  onApprove,
  onDeny,
}: {
  steps: ProcessStep[];
  streaming: boolean;
  latencyMs?: number;
  onApprove?(): void;
  onDeny?(): void;
}) {
  const completedStep: ProcessStep | undefined = streaming
    ? undefined
    : {
        id: "complete",
        label: formatDuration(latencyMs),
        detail: "Done",
        icon: CheckmarkCircle02Icon,
        status: "done",
      };
  const visibleSteps = completedStep ? [...steps, completedStep] : steps;

  return (
    <ol className="mt-4 max-w-[42rem]">
      {visibleSteps.map((step, index) => {
        const isLast = index === visibleSteps.length - 1;
        const isRunning = step.status === "running";
        const isApproval = step.status === "approval";
        const isError = step.status === "error";
        const usesThinkingDot = step.id === "active" || step.id === "reasoning";

        return (
          <li
            key={step.id}
            className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0"
          >
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-[8px] top-[20px] w-px bg-border/55"
              />
            )}
            <span
              className={cn(
                "relative z-10 flex h-[18px] w-[18px] items-center justify-center bg-background text-muted-foreground/75",
                usesThinkingDot ? "mt-[5px]" : "mt-px",
                step.status === "done" && "text-foreground/90",
                isError && "text-destructive",
                isApproval && "text-amber-300/90",
              )}
            >
              {usesThinkingDot && !isError ? (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
              ) : (
                <HugeiconsIcon
                  icon={isError ? AlertCircleIcon : step.icon}
                  size={15}
                  color="currentColor"
                  strokeWidth={1.65}
                  aria-hidden="true"
                />
              )}
            </span>
            <div className="min-w-0 pt-px">
              {isRunning ? (
                <ThinkingIndicator label={step.label} />
              ) : (
                <p className="text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-foreground/86">
                  {step.label}
                </p>
              )}
              {step.detail && (
                <p className="mt-1 max-w-[38rem] text-[12px] leading-[1.55] text-muted-foreground/62">
                  {step.detail}
                </p>
              )}
              {isApproval && onApprove && onDeny && (
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onApprove}
                    className="rounded-md bg-foreground px-3 py-1.5 text-[11px] font-semibold text-background transition-opacity hover:opacity-85 active:translate-y-px"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={onDeny}
                    className="rounded-md px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground active:translate-y-px"
                  >
                    Deny
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ResourceGroup({
  title,
  items,
  icon,
}: {
  title: string;
  items: Array<{ id: string; label: string; detail?: string; href?: string }>;
  icon: ProcessIcon;
}) {
  if (items.length === 0) return null;

  return (
    <section className="mt-8 max-w-[42rem]">
      <h4 className="text-[14px] font-medium tracking-[-0.015em] text-foreground/72">
        {title} <span className="text-muted-foreground/45">· {items.length}</span>
      </h4>
      <div className="mt-4 space-y-5">
        {items.map((item) => (
          <div key={item.id} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-3">
            <span className="mt-px flex h-[18px] w-[18px] items-center justify-center text-muted-foreground/70">
              <HugeiconsIcon
                icon={icon}
                size={16}
                color="currentColor"
                strokeWidth={1.55}
                aria-hidden="true"
              />
            </span>
            <div className="min-w-0">
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className="line-clamp-1 text-[13px] font-medium leading-[18px] text-foreground/88 underline-offset-4 hover:underline"
                >
                  {item.label}
                </a>
              ) : (
                <p className="line-clamp-1 text-[13px] font-medium leading-[18px] text-foreground/88">
                  {item.label}
                </p>
              )}
              {item.detail && (
                <p className="mt-1 line-clamp-2 text-[12px] leading-[1.5] text-muted-foreground/58">
                  {item.detail}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ActivityPanel({
  artifacts,
  hasVisibleContent,
  latencyMs,
  reasoning,
  streaming,
  toolCalls,
  onApprove,
  onDeny,
}: ActivityPanelProps) {
  const [open, setOpen] = React.useState(false);

  const uniqueArtifacts = React.useMemo(() => {
    const seen = new Set<string>();
    return artifacts.filter((artifact) => {
      const key = [artifact.kind, artifact.detail?.toLowerCase() ?? "", artifact.resultCount ?? ""].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [artifacts]);

  const steps = React.useMemo(() => {
    const next: ProcessStep[] = [];
    if (reasoning?.trim()) {
      next.push({
        id: "reasoning",
        label: streaming ? "Considering the request" : "Considered the request",
        detail: normalizeText(reasoning, 300),
        icon: AiBrain01Icon,
        status: "info",
      });
    }

    toolCalls.forEach((call) => {
      const presentation = toolPresentation(call);
      next.push({
        id: call.callId,
        ...presentation,
        detail: toolDetail(call),
        status: call.status,
      });
    });

    uniqueArtifacts.forEach((artifact, index) => {
      next.push(artifactPresentation(artifact, index));
    });

    const hasRunningStep = next.some((step) => step.status === "running" || step.status === "approval");
    if (streaming && !hasRunningStep) {
      next.push({
        id: "active",
        label: hasVisibleContent ? "Writing the response" : "Thinking",
        icon: AiBrain01Icon,
        status: "running",
      });
    }

    return next;
  }, [hasVisibleContent, reasoning, streaming, toolCalls, uniqueArtifacts]);

  const memoryItems = React.useMemo(() => toolCalls
    .filter((call) => /memory_query|past_chat|conversation_search/.test(call.name))
    .map((call) => ({
      id: `memory-${call.callId}`,
      label: toolPresentation(call).label,
      detail: toolDetail(call),
    })), [toolCalls]);

  const fileItems = React.useMemo(() => {
    const seen = new Set<string>();

    return toolCalls
      .filter((call) => /document_|file_reader|vision_/.test(call.name))
      .flatMap((call) => {
        const path = fileResourcePath(call);
        if (!path) return [];

        const key = path.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);

        const label = fileResourceName(path);
        return [{
          id: `file-${call.callId}`,
          label,
          detail: label === path ? undefined : path,
        }];
      });
  }, [toolCalls]);

  const sourceItems = React.useMemo(() => uniqueSources(uniqueArtifacts).map((source, index) => ({
    id: `source-${index}-${source.url}`,
    label: source.title,
    detail: source.url,
    href: source.url,
  })), [uniqueArtifacts]);

  return (
    <section className="not-prose mb-5 max-w-[42rem]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "group -ml-1 inline-flex items-center gap-2 rounded-sm py-1 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-4 focus-visible:ring-offset-background",
        )}
      >
        {streaming ? (
          <>
            <ThinkingOrb
              state="working"
              size={20}
              speed={0.95}
              aria-hidden="true"
              className="shrink-0"
            />
            <ThinkingIndicator
              label="Thinking"
              className="py-0 text-[15px] tracking-[-0.02em]"
            />
          </>
        ) : (
          <span className="text-[15px] font-medium tracking-[-0.02em] text-muted-foreground/50 transition-colors duration-200 group-hover:text-muted-foreground group-focus-visible:text-muted-foreground">
            Thought
          </span>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={15}
          color="currentColor"
          strokeWidth={1.6}
          aria-hidden="true"
          className={cn(
            "text-muted-foreground/50 transition-transform duration-200 ease-out group-hover:text-muted-foreground",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-200">
          <ProcessTimeline
            steps={steps}
            streaming={streaming}
            latencyMs={latencyMs}
            onApprove={onApprove}
            onDeny={onDeny}
          />
          <ResourceGroup title="Memory" items={memoryItems} icon={Database01Icon} />
          <ResourceGroup title="Sources" items={sourceItems} icon={Link01Icon} />
          <ResourceGroup title="Files" items={fileItems} icon={File01Icon} />
        </div>
      )}
    </section>
  );
}
