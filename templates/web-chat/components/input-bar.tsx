"use client";

import * as React from "react";
import { ArrowUp, Mic, Paperclip, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ImagePreview } from "@/components/image-preview";
import type { UiFile } from "@/lib/types";

interface InputBarProps {
  onSend(message: string): void;
  onStop(): void;
  onClear?(): void;
  streaming: boolean;
  disabled?: boolean;
  hasMessages?: boolean;
  /** Files currently being prepared (processing or ready). */
  pendingFiles: UiFile[];
  /** Called when the user picks new files from the file picker. */
  onFilesSelected(files: File[]): void;
  /** Called when the user removes a pending file. */
  onRemoveFile(fileId: string): void;
  leftSlot?: React.ReactNode;
  onMic?(): void;
  micActive?: boolean;
}

export function InputBar({
  onSend,
  onStop,
  onClear,
  streaming,
  disabled,
  hasMessages,
  pendingFiles,
  onFilesSelected,
  onRemoveFile,
  leftSlot,
  onMic,
  micActive,
}: InputBarProps) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if ((trimmed.length === 0 && pendingFiles.length === 0) || streaming || disabled) return;
    if (pendingFiles.some((f) => f.loading)) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(event.target.value);
    const el = event.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files;
    if (next === null) return;
    onFilesSelected(Array.from(next));
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="shrink-0 bg-transparent px-4 pt-4 pb-6">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "relative flex flex-col rounded-2xl border border-border/60 bg-muted backdrop-blur-md p-3 transition-all",
            "hover:border-border/70 hover:bg-muted",
            "focus-within:border-border/80 focus-within:ring-1 focus-within:ring-white/20",
          )}
        >
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {pendingFiles.map((f) => (
                <ImagePreview
                  key={f.id}
                  file={f}
                  chip
                  onRemove={f.loading ? undefined : () => onRemoveFile(f.id)}
                />
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Ask a question..."
            disabled={disabled}
            className={cn(
              "max-h-40 min-h-[48px] w-full resize-none bg-transparent py-1.5 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none leading-relaxed",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />

          <div className="flex items-center justify-between pt-2.5 mt-2 select-none">
            <div className="flex items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={onFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={openFilePicker}
                disabled={streaming || pendingFiles.some((f) => f.loading)}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground/60 transition-colors",
                  "hover:bg-muted/30 hover:text-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                aria-label="Attach files"
                title="Attach files"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onMic}
                disabled={streaming || onMic === undefined}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-full transition-colors",
                  micActive
                    ? "bg-red-500/15 text-red-400 animate-pulse"
                    : "text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                aria-label={micActive ? "Stop recording" : "Voice input"}
                title={
                  onMic === undefined
                    ? "Voice input — wire onMic to enable"
                    : micActive
                      ? "Stop recording"
                      : "Voice input"
                }
              >
                <Mic className="h-4 w-4" />
              </button>
              {leftSlot}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {hasMessages && onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground transition-colors"
                  aria-label="New chat"
                  title="New chat"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              {streaming ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="h-8 w-8 flex items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 transition-colors"
                  aria-label="Stop generation"
                >
                  <Square className="h-3 w-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={(value.trim().length === 0 && pendingFiles.length === 0) || disabled || pendingFiles.some((f) => f.loading)}
                  className={cn(
                    "h-8 w-8 flex items-center justify-center rounded-full bg-foreground text-background transition-colors",
                    "hover:bg-foreground/90",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                  aria-label="Send message"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
