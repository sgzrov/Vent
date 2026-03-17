import { Suspense } from "react";
import CliAuthContent from "./cli-auth-content";

export default function CliAuthPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Suspense
        fallback={
          <div className="text-center max-w-md px-6">
            <h1 className="text-xl font-semibold tracking-tight">
              Authorizing CLI...
            </h1>
            <p className="text-muted-foreground mt-2 text-sm">Loading...</p>
          </div>
        }
      >
        <CliAuthContent />
      </Suspense>
    </div>
  );
}
