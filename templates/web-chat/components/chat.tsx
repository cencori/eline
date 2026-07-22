"use client";

import * as React from "react";
import { InputBar } from "@/components/input-bar";
import { Message } from "@/components/message";
import { readArcieStream } from "@/lib/stream";
import type { AgentInfo, UiFile, UiMessage, UiToolCall } from "@/lib/types";

function resizeImage(file: File, maxDim: number, quality: number): Promise<UiFile> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = width > height ? maxDim / width : maxDim / height;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas 2D not available")); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, width, height);
      const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
      const dataUrl = canvas.toDataURL(mimeType, mimeType === "image/jpeg" ? quality : undefined);
      resolve({ id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, type: mimeType, dataUrl, size: dataUrl.length });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const STREAM_REVEAL_THRESHOLD = 80;
const STREAM_REVEAL_CHUNK_SIZE = 18;
const STREAM_REVEAL_DELAY_MS = 20;

function splitStreamDelta(delta: string): string[] {
  const tokens = delta.match(/\s+|[^\s]+/g) ?? [delta];
  const chunks: string[] = [];
  let chunk = "";

  for (const token of tokens) {
    if (chunk.length > 0 && chunk.length + token.length > STREAM_REVEAL_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = token;
    } else {
      chunk += token;
    }
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function Chat() {
  const [messages, setMessages] = React.useState<UiMessage[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = React.useState<string>("agent");
  const abortRef = React.useRef<AbortController | undefined>(undefined);
  const sessionRef = React.useRef<string | undefined>(undefined);
  const conversationRef = React.useRef<string>(newId("c"));
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileMessageRef = React.useRef<string | undefined>(undefined);

  const [pendingFiles, setPendingFiles] = React.useState<UiFile[]>([]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  React.useEffect(() => {
    fetch("/api/agents")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (Array.isArray(list)) setAgents(list as AgentInfo[]);
      })
      .catch(() => {});
  }, []);

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const clearAll = () => {
    if (streaming) stop();
    setMessages([]);
    sessionRef.current = undefined;
    conversationRef.current = newId("c");
  };

  const switchAgent = (id: string) => {
    setAgentId(id);
    clearAll();
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  const patchMessage = React.useCallback(
    (id: string, patch: (prev: UiMessage) => UiMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
    },
    [],
  );

  /**
   * Consumes an arcie NDJSON stream into the assistant message with the
   * given id. Used for both fresh turns and approval resumes, so tool
   * cards are matched by callId rather than arrival order.
   */
  const clearFileLoading = React.useCallback(() => {
    const fileMsgId = fileMessageRef.current;
    if (fileMsgId !== undefined) {
      fileMessageRef.current = undefined;
      patchMessage(fileMsgId, (m) => ({
        ...m,
        files: m.files?.map((f) => ({ ...f, loading: false })),
      }));
    }
  }, [patchMessage]);

  const streamInto = React.useCallback(
    async (assistantId: string, response: Response, signal: AbortSignal) => {
      const patchAssistant = (patch: (prev: UiMessage) => UiMessage) =>
        patchMessage(assistantId, patch);

      const appendText = async (delta: string) => {
        if (delta.length === 0) return;

        const chunks =
          delta.length >= STREAM_REVEAL_THRESHOLD ? splitStreamDelta(delta) : [delta];

        for (const chunk of chunks) {
          if (signal.aborted) return;
          patchAssistant((m) => ({ ...m, content: `${m.content}${chunk}` }));

          if (chunks.length > 1) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, STREAM_REVEAL_DELAY_MS);
            });
          }
        }
      };

      const patchToolCall = (callId: string, patch: (prev: UiToolCall) => UiToolCall) => {
        patchAssistant((m) => {
          const toolCalls = [...(m.toolCalls ?? [])];
          const idx = toolCalls.findIndex((c) => c.callId === callId);
          if (idx === -1) return m;
          toolCalls[idx] = patch(toolCalls[idx]!);
          return { ...m, toolCalls };
        });
      };

      let firstEvent = true;

      for await (const event of readArcieStream(response)) {
        if (signal.aborted) break;
        if (firstEvent) {
          firstEvent = false;
          clearFileLoading();
        }
        switch (event.type) {
          case "session.started": {
            const sid = (event.data as { sessionId?: string }).sessionId;
            if (sid) sessionRef.current = sid;
            break;
          }
          case "message.appended": {
            const delta = (event.data as { delta?: string }).delta ?? "";
            await appendText(delta);
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
              kind: "tool",
            };
            patchAssistant((m) => {
              const toolCalls = m.toolCalls ?? [];
              if (toolCalls.some((c) => c.callId === data.callId)) return m;
              return { ...m, toolCalls: [...toolCalls, call] };
            });
            break;
          }
          case "subagent.called": {
            const data = event.data as { callId: string };
            patchToolCall(data.callId, (c) => ({ ...c, kind: "subagent" }));
            break;
          }
          case "tool.completed": {
            const data = event.data as {
              callId: string;
              output: unknown;
              status: string;
              error?: { code: string; message: string };
            };
            const isApproval = data.status === "pending" && data.error?.code === "needs_approval";
            patchToolCall(data.callId, (c) => ({
              ...c,
              status: isApproval
                ? "approval"
                : data.status === "completed"
                  ? "done"
                  : data.status === "rejected"
                    ? "denied"
                    : "error",
              output: data.output,
              errorMessage: data.error?.message,
            }));
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
    },
    [patchMessage, clearFileLoading],
  );

  const runRequest = React.useCallback(
    async (assistantId: string, body: Record<string, unknown>) => {
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = Date.now();

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          clearFileLoading();
          const text = await response.text();
          patchMessage(assistantId, (m) => ({
            ...m,
            content: text || `Server error (${response.status})`,
            streaming: false,
            errored: true,
          }));
          return;
        }
        await streamInto(assistantId, response, controller.signal);
      } catch (error) {
        clearFileLoading();
        if (!controller.signal.aborted) {
          patchMessage(assistantId, (m) => ({
            ...m,
            content: error instanceof Error ? error.message : String(error),
            streaming: false,
            errored: true,
          }));
        }
      } finally {
        clearFileLoading();
        const latencyMs = Date.now() - startedAt;
        patchMessage(assistantId, (m) => ({ ...m, streaming: false, latencyMs }));
        setStreaming(false);
        abortRef.current = undefined;
      }
    },
    [patchMessage, streamInto, clearFileLoading],
  );

  const processFiles = React.useCallback(async (rawFiles: File[]): Promise<UiFile[]> => {
    const MAX_DIM = 2048;
    const JPEG_QUALITY = 0.82;

    return Promise.all(
      rawFiles.map(async (f) => {
        const id = newId("f");
        if (!f.type.startsWith("image/")) {
          const buf = await f.arrayBuffer();
          const base64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCodePoint(b), ""));
          return { id, name: f.name, type: f.type, dataUrl: `data:${f.type};base64,${base64}`, size: f.size };
        }
        return resizeImage(f, MAX_DIM, JPEG_QUALITY);
      }),
    );
  }, []);

  const onFilesSelected = React.useCallback((rawFiles: File[]) => {
    const entries = rawFiles.map((f) => ({
      id: newId("f"),
      name: f.name,
      type: f.type,
      dataUrl: "",
      size: f.size,
      loading: true,
    }));
    setPendingFiles((prev) => [...prev, ...entries]);

    for (let i = 0; i < rawFiles.length; i++) {
      const rawFile = rawFiles[i]!;
      const entryId = entries[i]!.id;
      processFiles([rawFile]).then((processed) => {
        const pf = processed[0]!;
        setPendingFiles((prev) =>
          prev.map((p) => (p.id === entryId ? { ...pf, id: entryId, loading: false } : p)),
        );
      });
    }
  }, [processFiles]);

  const removePendingFile = React.useCallback((fileId: string) => {
    setPendingFiles((prev) => prev.filter((p) => p.id !== fileId));
  }, []);

  const send = React.useCallback(
    async (text: string, historyOverride?: UiMessage[]) => {
      const base = historyOverride ?? messages;
      const uiFiles = pendingFiles;

      const userMessageId = newId("u");
      const userMessage: UiMessage = {
        id: userMessageId,
        role: "user",
        content: text,
        files: uiFiles.length > 0 ? uiFiles : undefined,
      };
      if (uiFiles.length > 0) fileMessageRef.current = userMessageId;
      setPendingFiles([]);
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

      await runRequest(assistantId, {
        message: text,
        files: uiFiles.map((f) => ({ name: f.name, type: f.type, dataUrl: f.dataUrl })),
        sessionId: sessionRef.current,
        threadId: conversationRef.current,
        ...(agentId !== "agent" ? { agentId } : {}),
      });
    },
    [messages, agentId, runRequest, pendingFiles],
  );

  /**
   * Resolves every tool call awaiting approval in the given assistant
   * message, then resumes the paused turn so the model continues with
   * the results (or refusals).
   */
  const resolveApprovals = React.useCallback(
    async (assistantId: string, approved: boolean) => {
      const msg = messages.find((m) => m.id === assistantId);
      const pending = (msg?.toolCalls ?? []).filter((c) => c.status === "approval");
      if (pending.length === 0 || sessionRef.current === undefined) return;

      patchMessage(assistantId, (m) => ({
        ...m,
        streaming: true,
        toolCalls: (m.toolCalls ?? []).map((c) =>
          c.status === "approval" ? { ...c, status: approved ? "running" : "denied" } : c,
        ),
      }));

      await runRequest(assistantId, {
        sessionId: sessionRef.current,
        threadId: conversationRef.current,
        ...(agentId !== "agent" ? { agentId } : {}),
        resume: {
          toolCalls: pending.map((c) => ({
            actionId: c.callId,
            name: c.name,
            args: c.input,
            approved,
          })),
        },
      });
    },
    [messages, agentId, patchMessage, runRequest],
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
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground">
      {agents.length > 1 && (
        <div className="flex justify-center pt-3">
          <select
            value={agentId}
            onChange={(e) => switchAgent(e.target.value)}
            disabled={streaming}
            className="rounded-md border border-border/40 bg-background px-2 py-1 text-xs text-muted-foreground focus:outline-none"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

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
                onApprove={() => void resolveApprovals(message.id, true)}
                onDeny={() => void resolveApprovals(message.id, false)}
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
        pendingFiles={pendingFiles}
        onFilesSelected={onFilesSelected}
        onRemoveFile={removePendingFile}
      />
    </div>
  );
}
