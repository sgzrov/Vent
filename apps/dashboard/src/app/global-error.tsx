"use client";

export default function GlobalError({
  error: _error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ padding: 40, fontFamily: "monospace", color: "#ff6b6b", background: "#111" }}>
        <h2>Application Error</h2>
        <p style={{ color: "#bbb", maxWidth: 480 }}>
          The dashboard hit an unexpected error. Please refresh and try again.
        </p>
      </body>
    </html>
  );
}
