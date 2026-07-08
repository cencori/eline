"use client";

import * as React from "react";
import { InputBar } from "@/components/input-bar";
import { Message } from "@/components/message";
import { readArcieStream } from "@/lib/stream";
import type { UiMessage, UiToolCall } from "@/lib/types";

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function Chat() {
  const [messages, setMessages] = React.useState<UiMessage[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const abortRef = React.useRef<AbortController | undefined>(undefined);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const clearAll = () => {
    if (streaming) stop();
    setMessages([]);
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  const send = React.useCallback(
    async (text: string, historyOverride?: UiMessage[]) => {
      const base = historyOverride ?? messages;
      const userMessage: UiMessage = { id: newId("u"), role: "user", content: text };
      const assistantId = newId("a");
      const assistantMessage: UiMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
        toolCalls: [],
      };
      const isRegeneration = historyOverride !== undefined;
      setMessages((prev) => (isRegeneration ? [...base, assistantMessage] : [...prev, userMessage, assistantMessage]));
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = Date.now();

      const patchAssistant = (patch: (prev: UiMessage) => UiMessage) => {
        setMessages((prev) =>
          prev.map((message) => (message.id === assistantId ? patch(message) : message)),
        );
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          patchAssistant((m) => ({
            ...m,
            content: body || `Server error (${response.status})`,
            streaming: false,
            errored: true,
          }));
          return;
        }

        const toolIndex = new Map<string, number>();

        for await (const event of readArcieStream(response)) {
          switch (event.type) {
            case "message.appended": {
              const delta = (event.data as { delta?: string }).delta ?? "";
              patchAssistant((m) => ({ ...m, content: `${m.content}${delta}` }));
              break;
            }
            case "message.completed": {
              const finished = (event.data as { text?: string | null }).text;
              patchAssistant((m) => ({
                ...m,
                content: typeof finished === "string" && finished.length > 0 ? finished : m.content,
              }));
              break;
            }
            case "reasoning.appended": {
              const delta = (event.data as { delta?: string }).delta ?? "";
              patchAssistant((m) => ({ ...m, reasoning: `${m.reasoning ?? ""}${delta}` }));
              break;
            }
            case "tool.started": {
              const data = event.data as { name: string; callId: string; input: unknown };
              const call: UiToolCall = {
                callId: data.callId,
                name: data.name,
                input: data.input,
                status: "running",
              };
              patchAssistant((m) => {
                const toolCalls = m.toolCalls ?? [];
                toolIndex.set(data.callId, toolCalls.length);
                return { ...m, toolCalls: [...toolCalls, call] };
              });
              break;
            }
            case "tool.completed": {
              const data = event.data as {
                callId: string;
                output: unknown;
                status: string;
                error?: { code: string; message: string };
              };
              patchAssistant((m) => {
                const toolCalls = [...(m.toolCalls ?? [])];
                const idx = toolIndex.get(data.callId);
                if (idx === undefined || toolCalls[idx] === undefined) return m;
                const previous = toolCalls[idx];
                const isApproval =
                  data.status === "pending" && data.error?.code === "needs_approval";
                toolCalls[idx] = {
                  ...previous,
                  status: isApproval
                    ? "approval"
                    : data.status === "completed"
                      ? "done"
                      : "error",
                  output: data.output,
                  errorMessage: data.error?.message,
                };
                return { ...m, toolCalls };
              });
              break;
            }
            case "step.failed":
            case "turn.failed":
            case "session.failed": {
              const data = event.data as { code?: string; message?: string };
              patchAssistant((m) => ({
                ...m,
                content: data.message ?? "Something went wrong.",
                streaming: false,
                errored: true,
              }));
              break;
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          patchAssistant((m) => ({
            ...m,
            content: error instanceof Error ? error.message : String(error),
            streaming: false,
            errored: true,
          }));
        }
      } finally {
        const latencyMs = Date.now() - startedAt;
        patchAssistant((m) => ({ ...m, streaming: false, latencyMs }));
        setStreaming(false);
        abortRef.current = undefined;
      }
    },
    [messages],
  );

  const regenerate = () => {
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIndex === -1) return;
    const historyBefore = messages.slice(0, lastUserIndex);
    const lastUser = messages[lastUserIndex]!;
    setMessages([...historyBefore, lastUser]);
    void send(lastUser.content, [...historyBefore, lastUser]);
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-start gap-6 pt-8 pb-4">
          {messages.map((message, index) => {
            const isLast =
              message.role === "assistant" && index === messages.length - 1 && !streaming;
            return (
              <Message
                key={message.id}
                message={message}
                isLast={isLast}
                onCopy={copy}
                onRegenerate={regenerate}
              />
            );
          })}
        </div>
      </div>

      <InputBar
        onSend={(text) => void send(text)}
        onStop={stop}
        onClear={clearAll}
        streaming={streaming}
        hasMessages={messages.length > 0}
      />
    </div>
  );
}
