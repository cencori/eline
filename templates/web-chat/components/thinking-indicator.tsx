"use client";

import { cn } from "@/lib/utils";

export function ThinkingIndicator({
  className,
  label = "Thinking",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span className={cn("thinking-shimmer inline-block py-0.5 text-[13px] font-medium", className)}>
      {label}
    </span>
  );
}
