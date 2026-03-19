import * as React from "react";
import { cn } from "@/lib/utils";

interface MarqueeProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  pauseOnHover?: boolean;
  reverse?: boolean;
  repeat?: number;
  speed?: number;
  gap?: string;
}

export function Marquee({
  children,
  pauseOnHover = false,
  reverse = false,
  repeat = 4,
  speed = 40,
  gap = "1rem",
  className,
  ...props
}: MarqueeProps) {
  return (
    <div
      className={cn("overflow-hidden", className)}
      style={
        {
          "--duration": `${speed}s`,
          "--gap": gap,
        } as React.CSSProperties
      }
      {...props}
    >
      <div
        className={cn(
          "flex shrink-0 justify-around",
          "[gap:var(--gap)]",
          pauseOnHover && "hover:[animation-play-state:paused]"
        )}
      >
        {Array.from({ length: repeat }).map((_, i) => (
          <div
            key={i}
            aria-hidden={i > 0}
            className={cn(
              "flex shrink-0 items-center justify-around",
              "[gap:var(--gap)]",
              "animate-marquee",
              reverse && "[animation-direction:reverse]"
            )}
          >
            {children}
          </div>
        ))}
      </div>
    </div>
  );
}
