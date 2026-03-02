"use client";

export default function Error({
  error: _error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 40, fontFamily: "monospace", color: "#ff6b6b" }}>
      <h2>Something went wrong</h2>
      <p style={{ color: "#bbb", maxWidth: 480 }}>
        An unexpected error occurred while rendering this page.
      </p>
    </div>
  );
}
