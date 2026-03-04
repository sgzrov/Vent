import Link from "next/link";
import { redirect } from "next/navigation";
import {
  withAuth,
  getSignInUrl,
  getSignUpUrl,
} from "@workos-inc/authkit-nextjs";
import { Button } from "@/components/ui/button";
import { CopyCommandButton } from "@/components/copy-command-button";
import { LightningBolt } from "@/components/lightning-bolt";

export default async function LandingPage() {
  const { user } = await withAuth();

  if (user) {
    redirect("/runs");
  }

  const signInUrl = await getSignInUrl();
  const signUpUrl = await getSignUpUrl();

  return (
    <div className="min-h-screen flex flex-col bg-background relative overflow-hidden">
      {/* Grid background */}
      <div className="absolute inset-0 grid-bg" />
      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background/80 to-background pointer-events-none" />

      <header className="relative z-10 border-b border-border/40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-1">
              <span className="font-cursive text-xl tracking-tight text-foreground">
                Light
              </span>
              <span className="text-xl font-semibold tracking-tight text-foreground">
                MCP
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" asChild>
                <Link href={signInUrl}>Log in</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href={signUpUrl}>Sign up</Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex items-center">
        <div className="max-w-7xl mx-auto px-6 w-full">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left side - Content */}
            <div className="space-y-8">
              <div>
                <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
                  <span className="relative inline-block">
                    <span className="font-cursive font-normal">Light</span>
                    <span className="absolute -bottom-1 left-0 right-0 h-[3px] bg-gradient-to-r from-yellow-400 via-amber-400 to-yellow-300 rounded-full energy-underline" />
                  </span>
                  <span className="ml-1">MCP</span>
                </h1>
              </div>

              <p className="text-lg sm:text-xl text-muted-foreground max-w-lg leading-relaxed">
                The first MCP that lets coding agents test voice agents in real
                time.
              </p>

              <div className="space-y-4">
                <CopyCommandButton command="npx lightmcp@latest init" />

                <div className="flex items-center gap-2 text-sm text-muted-foreground/70">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                  Available with Claude Code and Cursor
                </div>
              </div>

              <div className="flex items-center gap-4 pt-2">
                <Button size="lg" asChild>
                  <Link href={signUpUrl}>Get started</Link>
                </Button>
                <Button variant="outline" size="lg" asChild>
                  <Link href={signInUrl}>Log in</Link>
                </Button>
              </div>
            </div>

            {/* Right side - Lightning bolt */}
            <div className="flex items-center justify-center lg:justify-end">
              <LightningBolt />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
