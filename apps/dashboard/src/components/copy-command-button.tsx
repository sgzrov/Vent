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
      className="group flex items-center gap-3 bg-zinc-900 text-zinc-100 rounded-lg px-4 py-3 font-mono text-sm hover:bg-zinc-800 transition-colors w-fit cursor-pointer"
    >
      <span className="text-zinc-500 select-none">$</span>
      <span>{command}</span>
      {copied ? (
        <Check className="h-4 w-4 text-green-400 ml-2" />
      ) : (
        <Copy className="h-4 w-4 text-zinc-500 group-hover:text-zinc-300 transition-colors ml-2" />
      )}
    </button>
  );
}
