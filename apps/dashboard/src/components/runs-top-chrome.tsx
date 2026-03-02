"use client";

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

const typeFilters = ["All", "Audio", "Conversations", "Security"] as const;

export function RunsTopChrome() {
  return (
    <>
      <div className="h-16 flex items-center">
        <h1 className="text-[1.125rem] leading-none font-medium tracking-[-0.01em]">
          Runs
        </h1>
      </div>
      <div className="-mx-7 border-b mb-7" />

      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/45" />
          <input
            type="text"
            placeholder="Search runs..."
            readOnly
            className="w-full h-10 pl-10 pr-4 text-[14px] bg-background border border-border/80 rounded-xl placeholder:text-muted-foreground/45 focus:outline-none"
          />
        </div>
        <div className="flex gap-1.5">
          {typeFilters.map((label, idx) => (
            <button
              key={label}
              type="button"
              className={cn(
                "text-[13px] font-medium h-9 px-3.5 rounded-xl transition-colors",
                idx === 0
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground/80 hover:text-foreground hover:bg-muted"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
