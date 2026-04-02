"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createAccessToken } from "@/lib/api";

export default function CliAuthContent() {
  const searchParams = useSearchParams();
  const port = searchParams.get("port");
  const state = searchParams.get("state");
  const [status, setStatus] = useState<"authorizing" | "error">("authorizing");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!port || !state) {
      setStatus("error");
      setErrorMessage("Missing parameters. Run `vent login` from your terminal.");
      return;
    }

    const portNum = parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum < 1024 || portNum > 65535) {
      setStatus("error");
      setErrorMessage("Invalid port. Run `vent login` again.");
      return;
    }

    let cancelled = false;

    async function authorize() {
      try {
        const data = await createAccessToken("Vent CLI Login");

        if (cancelled) return;

        const callbackUrl = new URL(`http://127.0.0.1:${portNum}/callback`);
        callbackUrl.searchParams.set("access_token", data.access_token);
        callbackUrl.searchParams.set("state", state!);

        window.location.href = callbackUrl.toString();
      } catch {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage("Failed to create access token. Try again.");
      }
    }

    authorize();

    return () => {
      cancelled = true;
    };
  }, [port, state]);

  return (
    <div className="text-center max-w-md px-6">
      {status === "authorizing" ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">
            Authorizing CLI...
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Creating a Vent access token and redirecting back to your terminal.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight text-destructive">
            Authentication failed
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">{errorMessage}</p>
        </>
      )}
    </div>
  );
}
