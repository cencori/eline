"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/lib/types";
import { parseAssistantOutput } from "@/lib/assistant-output";
import { normalizeMarkdownHierarchy } from "@/lib/markdown-hierarchy";
import { ImagePreview } from "@/components/image-preview";
import { CodeBlock } from "@/components/code-block";
import { ActivityPanel } from "@/components/activity-panel";

interface MessageProps {
  message: UiMessage;
  isLast?: boolean;
  onCopy?(text: string): void;
  onRegenerate?(): void;
  onApprove?(): void;
  onDeny?(): void;
}

interface MarkdownCodeProps {
  className?: string;
  children?: React.ReactNode;
}

export function Message({ message, isLast, onCopy, onRegenerate, onApprove, onDeny }: MessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = React.useState(false);

  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
  const parsedOutput = React.useMemo(
    () => parseAssistantOutput(message.content, {
      streaming: message.streaming === true,
      hasToolContext: hasToolCalls,
    }),
    [message.content, message.streaming, hasToolCalls],
  );
  const visibleContent = parsedOutput.text;
  const renderedContent = React.useMemo(
    () => normalizeMarkdownHierarchy(visibleContent),
    [visibleContent],
  );
  const hasActivity =
    hasToolCalls || parsedOutput.artifacts.length > 0 || Boolean(message.reasoning);
  const showActivity = hasActivity || message.streaming === true;

  const handleCopy = () => {
    if (onCopy === undefined) return;
    onCopy(visibleContent);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const markdownComponents = React.useMemo<Components>(
    () => ({
      pre: ({ children }: React.ComponentPropsWithoutRef<"pre">) => {
        const child = React.Children.toArray(children)[0];
        if (!React.isValidElement<MarkdownCodeProps>(child)) {
          return <pre>{children}</pre>;
        }

        const language = child.props.className?.match(/language-([^\s]+)/)?.[1];
        const code = String(child.props.children ?? "");
        return <CodeBlock code={code} language={language} onCopy={onCopy} />;
      },
      code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<"code">) => (
        <code className={cn("response-inline-code", className)} {...props}>
          {children}
        </code>
      ),
      h4: ({ children }) => <h3>{children}</h3>,
      h5: ({ children }) => <h3>{children}</h3>,
      h6: ({ children }) => <h3>{children}</h3>,
    }),
    [onCopy],
  );

  if (isUser) {
    return (
      <div className="flex flex-col px-4 items-end gap-2">
        {message.files && message.files.length > 0 && (
          <div className={cn("flex flex-wrap gap-2 justify-end", message.content.length > 0 && "mb-1")}>
            {message.files.map((file) => (
              <ImagePreview key={file.id} file={file} />
            ))}
          </div>
        )}
        {message.content.length > 0 && (
          <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-primary-foreground shadow-sm">
            <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap">
              {message.content}
            </p>
          </div>
        )}
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

        {showActivity && (
          <ActivityPanel
            key={message.streaming === true ? "working" : "thought"}
            artifacts={parsedOutput.artifacts}
            hasVisibleContent={visibleContent.length > 0}
            latencyMs={message.latencyMs}
            reasoning={message.reasoning}
            streaming={message.streaming === true}
            toolCalls={message.toolCalls ?? []}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        )}

        {visibleContent.length > 0 && (
          <article
            className={cn(
              "ai-response w-full max-w-[44rem]",
              message.errored && "text-destructive",
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {renderedContent}
            </ReactMarkdown>
          </article>
        )}

        {!message.streaming && visibleContent.length > 0 && (
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
