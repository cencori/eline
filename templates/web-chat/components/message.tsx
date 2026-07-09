"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/lib/types";
import { ToolCall } from "@/components/tool-call";

interface MessageProps {
  message: UiMessage;
  isLast?: boolean;
  onCopy?(text: string): void;
  onRegenerate?(): void;
}

export function Message({ message, isLast, onCopy, onRegenerate }: MessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    if (onCopy === undefined) return;
    onCopy(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (isUser) {
    return (
      <div className="flex flex-col px-4 items-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-primary-foreground shadow-sm">
          <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-4 items-start">
      <div className="w-full space-y-2">
        {message.errored && (
          <div className="mb-2 flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3 w-3" />
            <span>Error</span>
          </div>
        )}

        {message.reasoning && (
          <details className="text-[11px] text-muted-foreground/70 border border-border/20 rounded-lg px-2.5 py-1.5 bg-muted/10">
            <summary className="cursor-pointer select-none font-medium">thinking</summary>
            <div className="mt-1.5 whitespace-pre-wrap italic leading-relaxed">
              {message.reasoning}
            </div>
          </details>
        )}

        {message.streaming && message.content.length === 0 && !message.toolCalls?.length ? (
          <span className="inline-flex items-center gap-[3px]">
            <span
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce"
              style={{ animationDelay: "300ms" }}
            />
          </span>
        ) : (
          message.content.length > 0 && (
            <div
              className={cn(
                "prose prose-sm prose-zinc max-w-none dark:prose-invert",
                "prose-p:my-2 prose-p:leading-relaxed prose-p:text-sm",
                "prose-pre:my-2 prose-pre:text-sm",
                "prose-code:text-sm prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none",
                message.errored && "text-destructive",
              )}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {message.toolCalls.map((call) => (
              <ToolCall key={call.callId} call={call} />
            ))}
          </div>
        )}

        {!message.streaming && message.content.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {onCopy && (
              <button
                type="button"
                onClick={handleCopy}
                className={cn(
                  "h-6 w-6 flex items-center justify-center rounded transition-colors",
                  copied
                    ? "text-emerald-400"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/30",
                )}
                title={copied ? "Copied" : "Copy to clipboard"}
              >
                {copied ? (
                  <Check className="h-3 w-3 animate-in fade-in zoom-in-75 duration-150" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            )}
            {isLast && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors"
                title="Regenerate response"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
