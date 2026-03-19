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
import { ProviderCarousel } from "@/components/provider-carousel";

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
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-6">
              <span className="text-xl tracking-tight text-foreground" style={{ fontFamily: "var(--font-display)" }}>
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
              <a
                href="#"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
              >
                Docs
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
      <main className="relative z-10 flex-1 flex flex-col">
        <div className="w-full flex-1 flex flex-col px-6 lg:px-12 xl:px-16">
          {/* Headline — spans full width above the 2-col grid */}
          <div className="pt-16 lg:pt-24 pb-1 lg:pb-2">
            <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] tracking-tight leading-[1.35] max-w-2xl" style={{ fontFamily: "var(--font-heading)", fontWeight: 300 }}>
              Ship reliable{" "}
              <span className="relative inline-block italic text-[2.5rem] sm:text-[3.25rem] lg:text-[3.75rem]" style={{ fontFamily: "var(--font-accent)", fontWeight: 300 }}>
                voice agents
                <HandDrawnUnderline />
              </span>
              <br className="hidden sm:block" />
              {" "}without leaving your editor
            </h1>
          </div>

          {/* Two-column: left content, right demo */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-start pb-8">
            {/* Left side — Content */}
            <div className="space-y-5">
              <p className="text-base text-muted-foreground max-w-md leading-relaxed mt-4" style={{ fontWeight: 300 }}>
                Your coding agent triggers real calls, runs multi-turn
                conversations, and measures audio quality — then finds
                regressions and fixes your code, autonomously.
              </p>

              <div className="space-y-4 pt-10">
                <CopyCommandButton command="npx vent-hq@latest init" />
                <AgentCarousel />
              </div>

              {/* Provider carousel */}
              <ProviderCarousel />
            </div>

            {/* Right side — Demo video */}
            <div className="flex items-center justify-center lg:justify-end">
              <div className="relative w-full max-w-[620px]">
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
