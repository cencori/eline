"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly description: string;
}

interface AgentPickerProps {
  agents: readonly AgentSummary[];
  value: string;
  onChange(id: string): void;
}

export function AgentPicker({ agents, value, onChange }: AgentPickerProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const selected = agents.find((a) => a.id === value) ?? agents[0];

  if (agents.length === 0) return null;
  if (agents.length === 1) {
    return (
      <div className="px-2.5 py-1.5 rounded-xl text-[11px] font-medium bg-card/60 text-foreground truncate max-w-[220px]">
        {selected?.name ?? value}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-medium transition-all cursor-pointer",
          open ? "bg-primary/15 text-foreground ring-1 ring-primary/30" : "bg-card/60 hover:bg-card/85 text-foreground",
        )}
      >
        <span className="truncate max-w-[160px]">{selected?.name ?? value}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>

      {open && (
        <div className="absolute z-50 bottom-full mb-2 left-0 w-72 rounded-2xl border border-border/40 bg-popover shadow-2xl p-1.5 flex flex-col max-h-[320px] overflow-y-auto backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-150">
          {agents.map((agent) => {
            const isSelected = agent.id === value;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  onChange(agent.id);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-all hover:bg-muted/50 cursor-pointer",
                  isSelected && "bg-muted",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {agent.name}
                    </span>
                    {agent.model.length > 0 && (
                      <span className="text-[9px] text-muted-foreground/60 truncate font-mono">
                        {agent.model}
                      </span>
                    )}
                  </div>
                  {agent.description.length > 0 && (
                    <div className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed line-clamp-2">
                      {agent.description}
                    </div>
                  )}
                </div>
                {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
