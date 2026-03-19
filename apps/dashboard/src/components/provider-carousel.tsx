"use client";

import Image from "next/image";
import { Marquee } from "@/components/ui/marquee";

function WebSocketIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground/70">
      <path d="M4.5 8.5L8 12l-3.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 8.5L16 12l3.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 4v4M12 16v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

function SIPIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-muted-foreground/70">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 2c.5 0 1.5.5 2 1s1.5 1.5 2 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14.5 5.5c.5.25 1 .75 1.5 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

type Provider = {
  name: string;
  icon?: string;
  svg?: React.ReactNode;
};

const providers: Provider[] = [
  { name: "Vapi", icon: "/providers/vapi.png" },
  { name: "Retell", icon: "/providers/retell.png" },
  { name: "ElevenLabs", icon: "/providers/elevenlabs.png" },
  { name: "Bland", icon: "/providers/bland.png" },
  { name: "LiveKit", icon: "/providers/livekit.png" },
  { name: "WebSocket", svg: <WebSocketIcon /> },
  { name: "SIP", svg: <SIPIcon /> },
];

export function ProviderCarousel() {
  return (
    <div className="pt-6 space-y-2">
      <p className="text-[11px] text-muted-foreground/50 uppercase tracking-widest">
        Works with
      </p>

      <div className="relative">
        {/* Left fade */}
        <div className="absolute left-0 top-0 bottom-0 w-20 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
        {/* Right fade */}
        <div className="absolute right-0 top-0 bottom-0 w-20 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

        <Marquee speed={25} pauseOnHover repeat={4} gap="3rem">
          {providers.map((provider) => (
            <div
              key={provider.name}
              className="flex items-center gap-3 text-muted-foreground/60 shrink-0"
            >
              {provider.icon ? (
                <Image
                  src={provider.icon}
                  alt={provider.name}
                  width={24}
                  height={24}
                  className="rounded-sm"
                />
              ) : provider.svg ? (
                provider.svg
              ) : null}
              <span className="text-[15px] font-medium tracking-tight whitespace-nowrap">
                {provider.name}
              </span>
            </div>
          ))}
        </Marquee>
      </div>

      <p className="text-[11px] text-muted-foreground/35 tracking-wide">
        + custom endpoint or localhost
      </p>
    </div>
  );
}
