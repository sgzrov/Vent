import Link from "next/link";
import { redirect } from "next/navigation";
import {
  withAuth,
  getSignInUrl,
  getSignUpUrl,
} from "@workos-inc/authkit-nextjs";
import { CopyCommandButton } from "@/components/copy-command-button";
import { HandDrawnUnderline } from "@/components/hand-drawn-underline";
import { FallingPattern } from "@/components/ui/falling-pattern";
import { AgentCarousel } from "@/components/agent-carousel";

const adapters = [
  "Vapi",
  "Retell",
  "ElevenLabs",
  "Bland",
  "LiveKit",
  "WebSocket",
  "SIP",
];

export default async function LandingPage() {
  let signInUrl = "#";
  let signUpUrl = "#";

  try {
    const { user } = await withAuth();
    if (user) {
      redirect("/runs");
    }
    signInUrl = await getSignInUrl();
    signUpUrl = await getSignUpUrl();
  } catch {
    // Auth not configured — render landing page without auth links
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground relative overflow-hidden">
      {/* Falling pattern background */}
      <FallingPattern className="fixed inset-0 w-screen h-screen" />

      {/* Header */}
      <header className="relative z-10 border-b border-border/40">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <span className="text-lg font-semibold tracking-tight text-foreground">
                Vent
              </span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/sgzrov/Vent"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
              <Link
                href={signInUrl}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Log in
              </Link>
              <Link
                href={signUpUrl}
                className="text-sm bg-foreground text-background px-4 py-1.5 rounded-md font-medium hover:bg-foreground/90 transition-colors"
              >
                Get started
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex items-center">
        <div className="max-w-6xl mx-auto px-6 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center min-h-[calc(100vh-3.5rem)]">
            {/* Left side — Content */}
            <div className="space-y-8 py-20 lg:py-0">
              {/* Version pill */}
              <a
                href="https://github.com/sgzrov/Vent"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-xs text-muted-foreground border border-border/60 rounded-full px-4 py-1.5 hover:border-border hover:text-foreground transition-colors"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                Now supporting {adapters.length} voice platforms
                <span aria-hidden="true">&rarr;</span>
              </a>

              <div>
                <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
                  <span className="relative inline-block">
                    Vent
                    <HandDrawnUnderline />
                  </span>
                </h1>
              </div>

              <div className="space-y-3">
                <p className="text-lg sm:text-xl text-foreground font-medium">
                  CI/CD for voice AI agents.
                </p>
                <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                  Test latency, barge-in, conversation quality, and tool
                  calls — from your coding agent. Works with Claude Code,
                  Cursor, and Windsurf.
                </p>
              </div>

              <div className="space-y-4">
                <CopyCommandButton command="npx vent-hq@latest init" />
                <AgentCarousel />
                <div className="flex items-center gap-4 text-sm">
                  <Link
                    href={signUpUrl}
                    className="bg-foreground text-background px-5 py-2 rounded-md font-medium hover:bg-foreground/90 transition-colors"
                  >
                    Get started
                  </Link>
                  <Link
                    href={signInUrl}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Log in &rarr;
                  </Link>
                </div>
              </div>

              {/* Adapter strip */}
              <div className="pt-4 border-t border-border/30">
                <p className="text-[11px] text-muted-foreground/50 uppercase tracking-widest mb-3">
                  Works with
                </p>
                <div className="flex items-center gap-4 flex-wrap">
                  {adapters.map((name) => (
                    <span
                      key={name}
                      className="text-xs text-muted-foreground/60 font-medium"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Right side — Demo video */}
            <div className="flex items-center justify-center lg:justify-end">
              <div className="relative w-full max-w-[560px]">
                <div className="relative rounded-xl border border-border/60 bg-card/50 backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/20">
                  {/* Browser chrome */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40 bg-card/80">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/30" />
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/30" />
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/30" />
                    </div>
                    <div className="flex-1 text-center text-xs text-muted-foreground/50 font-mono">
                      vent — demo
                    </div>
                  </div>
                  {/* Video placeholder */}
                  <div className="aspect-video flex items-center justify-center bg-zinc-950/50">
                    <div className="text-center space-y-3">
                      <div className="w-14 h-14 rounded-full border-2 border-muted-foreground/20 flex items-center justify-center mx-auto">
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          className="text-muted-foreground/40 ml-1"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      <p className="text-sm text-muted-foreground/40">
                        Demo video coming soon
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
