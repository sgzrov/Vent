"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="group flex items-center gap-3 border border-border bg-transparent rounded-none px-4 py-3 text-sm hover:border-border transition-colors w-fit cursor-pointer"
      style={{ fontFamily: "var(--font-heading)" }}
    >
      <span className="text-muted-foreground/50 select-none">&gt;</span>
      <span className="text-foreground/80">{command}</span>
      {copied ? (
        <Check className="h-4 w-4 text-green-400 ml-2" />
      ) : (
        <Copy className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors ml-2" />
      )}
    </button>
  );
}
