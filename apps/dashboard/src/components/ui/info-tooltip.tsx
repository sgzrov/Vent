"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface InfoTooltipProps {
  content: string;
  className?: string;
}

export function InfoTooltip({ content, className }: InfoTooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <button
        type="button"
        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        aria-label="More info"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 rounded-md border bg-card px-3 py-2 text-xs text-card-foreground shadow-md">
          {content}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="h-2 w-2 rotate-45 border-b border-r bg-card" />
          </div>
        </div>
      )}
    </span>
  );
}
