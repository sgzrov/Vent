"use client";

import Image from "next/image";

export function LightningBolt() {
  return (
    <div className="relative w-[400px] h-[480px] select-none overflow-hidden">
      {/* Wind woosh lines */}
      <svg
        viewBox="0 0 400 480"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0 w-full h-full z-0"
      >
        <defs>
          <linearGradient id="woosh1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="40%" stopColor="hsl(220 8% 42% / 0.2)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="woosh2" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="hsl(220 8% 42% / 0.15)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="wooshGold" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="40%" stopColor="rgba(255, 217, 61, 0.15)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>

        {/* Woosh lines going upward (bolt is falling down) */}
        {/* Long swooping curves */}
        <path d="M 50 80 Q 120 90 200 60" stroke="url(#woosh1)" strokeWidth="2" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.8;0" dur="1.8s" repeatCount="indefinite" begin="0s" />
          <animateTransform attributeName="transform" type="translate" values="0,30;0,-50" dur="1.8s" repeatCount="indefinite" begin="0s" />
        </path>

        <path d="M 30 160 Q 100 155 180 135" stroke="url(#woosh2)" strokeWidth="1.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.6;0" dur="1.5s" repeatCount="indefinite" begin="0.4s" />
          <animateTransform attributeName="transform" type="translate" values="0,25;0,-45" dur="1.5s" repeatCount="indefinite" begin="0.4s" />
        </path>

        <path d="M 280 100 Q 330 95 380 70" stroke="url(#woosh1)" strokeWidth="2" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.7;0" dur="2s" repeatCount="indefinite" begin="0.2s" />
          <animateTransform attributeName="transform" type="translate" values="0,20;0,-55" dur="2s" repeatCount="indefinite" begin="0.2s" />
        </path>

        <path d="M 60 260 Q 130 250 210 230" stroke="url(#woosh2)" strokeWidth="1.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.6s" repeatCount="indefinite" begin="0.7s" />
          <animateTransform attributeName="transform" type="translate" values="0,20;0,-50" dur="1.6s" repeatCount="indefinite" begin="0.7s" />
        </path>

        <path d="M 260 220 Q 320 210 370 185" stroke="url(#wooshGold)" strokeWidth="2.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.7;0" dur="1.4s" repeatCount="indefinite" begin="0.3s" />
          <animateTransform attributeName="transform" type="translate" values="0,15;0,-40" dur="1.4s" repeatCount="indefinite" begin="0.3s" />
        </path>

        {/* Shorter speed lines */}
        <line x1="90" y1="340" x2="140" y2="320" stroke="url(#woosh2)" strokeWidth="1.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.6;0" dur="1.2s" repeatCount="indefinite" begin="0.5s" />
          <animateTransform attributeName="transform" type="translate" values="0,15;0,-35" dur="1.2s" repeatCount="indefinite" begin="0.5s" />
        </line>

        <line x1="300" y1="300" x2="360" y2="275" stroke="url(#woosh1)" strokeWidth="1.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.7s" repeatCount="indefinite" begin="0.9s" />
          <animateTransform attributeName="transform" type="translate" values="0,20;0,-40" dur="1.7s" repeatCount="indefinite" begin="0.9s" />
        </line>

        <line x1="40" y1="400" x2="100" y2="380" stroke="url(#wooshGold)" strokeWidth="2" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.3s" repeatCount="indefinite" begin="1.1s" />
          <animateTransform attributeName="transform" type="translate" values="0,10;0,-30" dur="1.3s" repeatCount="indefinite" begin="1.1s" />
        </line>

        <line x1="310" y1="380" x2="370" y2="360" stroke="url(#woosh2)" strokeWidth="1" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.4;0" dur="1.9s" repeatCount="indefinite" begin="0.6s" />
          <animateTransform attributeName="transform" type="translate" values="0,15;0,-35" dur="1.9s" repeatCount="indefinite" begin="0.6s" />
        </line>

        {/* Tiny dash marks - fast streaks */}
        <line x1="170" y1="180" x2="190" y2="172" stroke="hsl(220 8% 42% / 0.25)" strokeWidth="1" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.7;0" dur="0.8s" repeatCount="indefinite" begin="0.2s" />
          <animateTransform attributeName="transform" type="translate" values="0,10;0,-25" dur="0.8s" repeatCount="indefinite" begin="0.2s" />
        </line>

        <line x1="350" y1="150" x2="375" y2="140" stroke="hsl(220 8% 42% / 0.2)" strokeWidth="1" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0" dur="0.9s" repeatCount="indefinite" begin="0.8s" />
          <animateTransform attributeName="transform" type="translate" values="0,8;0,-20" dur="0.9s" repeatCount="indefinite" begin="0.8s" />
        </line>

        <line x1="20" y1="320" x2="50" y2="310" stroke="rgba(255,217,61,0.2)" strokeWidth="1.5" strokeLinecap="round" opacity="0">
          <animate attributeName="opacity" values="0;0.6;0" dur="1s" repeatCount="indefinite" begin="1.3s" />
          <animateTransform attributeName="transform" type="translate" values="0,8;0,-22" dur="1s" repeatCount="indefinite" begin="1.3s" />
        </line>
      </svg>

      {/* The bolt image — tilted and falling */}
      <div className="absolute inset-0 flex items-center justify-center z-10">
        <div className="bolt-falling relative">
          {/* Subtle glow behind bolt */}
          <div className="absolute inset-[-20px] rounded-full bg-amber-300/10 blur-2xl bolt-glow-pulse" />
          <Image
            src="/lightning-bolt.png"
            alt="LightMCP"
            width={300}
            height={300}
            className="relative z-10 rotate-[15deg] drop-shadow-[0_8px_32px_rgba(255,200,0,0.3)]"
            priority
          />
        </div>
      </div>
    </div>
  );
}
