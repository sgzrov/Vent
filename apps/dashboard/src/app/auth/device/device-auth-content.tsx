"use client";

import { useEffect, useState } from "react";

interface Props {
  code: string | null;
  isAuthenticated: boolean;
  signInUrl: string | null;
}

export function DeviceAuthContent({ code, isAuthenticated, signInUrl }: Props) {
  const [status, setStatus] = useState<
    "idle" | "approving" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!code) return;
    if (!isAuthenticated) return;
    if (status !== "idle") return;

    // Auto-approve immediately when authenticated
    setStatus("approving");

    fetch("/backend/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ user_code: code }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus("success");
        } else {
          const data = await res.json().catch(() => ({}));
          setStatus("error");
          setErrorMessage(
            data.error || "Failed to authorize. The code may have expired.",
          );
        }
      })
      .catch(() => {
        setStatus("error");
        setErrorMessage("Network error. Try again.");
      });
  }, [code, isAuthenticated, status]);

  // No code provided
  if (!code) {
    return (
      <div className="text-center max-w-md px-6">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Missing device code
        </h1>
        <p className="text-zinc-400 mt-2 text-sm">
          Run <code className="font-mono text-zinc-300">npx vent-hq login</code>{" "}
          from your terminal.
        </p>
      </div>
    );
  }

  // Not authenticated — show sign in
  if (!isAuthenticated && signInUrl) {
    return (
      <div className="text-center max-w-md px-6">
        <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
          Vent CLI
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-white mb-2">
          Sign in to authorize
        </h1>
        <p className="text-zinc-400 text-sm mb-1">
          Your device code
        </p>
        <p className="text-2xl font-mono font-bold text-white tracking-widest mb-8">
          {code}
        </p>
        <a
          href={signInUrl}
          className="inline-flex items-center justify-center rounded-md bg-white text-zinc-950 px-6 py-2.5 text-sm font-medium hover:bg-zinc-200 transition-colors"
        >
          Sign in
        </a>
      </div>
    );
  }

  // Approving
  if (status === "approving" || status === "idle") {
    return (
      <div className="text-center max-w-md px-6">
        <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
          Vent CLI
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Authorizing...
        </h1>
        <p className="text-zinc-400 mt-2 text-sm">
          Setting up your CLI access.
        </p>
      </div>
    );
  }

  // Success
  if (status === "success") {
    return (
      <div className="text-center max-w-md px-6">
        <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
          Vent CLI
        </p>
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-500/10 mb-4">
          <svg
            className="w-6 h-6 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-white">
          CLI authorized
        </h1>
        <p className="text-zinc-400 mt-2 text-sm">
          You can close this tab.
        </p>
      </div>
    );
  }

  // Error
  return (
    <div className="text-center max-w-md px-6">
      <p className="text-zinc-500 text-xs font-mono tracking-wider uppercase mb-6">
        Vent CLI
      </p>
      <h1 className="text-xl font-semibold tracking-tight text-red-400">
        Authorization failed
      </h1>
      <p className="text-zinc-400 mt-2 text-sm">{errorMessage}</p>
      <p className="text-zinc-500 mt-4 text-sm">
        Run <code className="font-mono text-zinc-400">npx vent-hq login</code>{" "}
        again.
      </p>
    </div>
  );
}
