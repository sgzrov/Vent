"use client";

import Image from "next/image";

export function LightningBolt() {
  return (
    <div className="relative w-[420px] h-[420px] select-none">
      {/* Wind woosh lines — coming from bottom-right (direction bolt flies toward) */}
      <svg
        viewBox="0 0 420 420"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0 w-full h-full z-0"
      >
        <defs>
          <linearGradient id="w1" x1="1" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="rgba(200,200,200,0.3)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
          <linearGradient id="w2" x1="1" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="50%" stopColor="rgba(255,217,61,0.2)" />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>

        {/* Long swooping wind arcs — trailing behind the bolt */}
        <path d="M 380 350 C 340 320, 280 310, 220 280" stroke="url(#w1)" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0">
          <animate attributeName="opacity" values="0;0.7;0" dur="1.6s" repeatCount="indefinite" begin="0s" />
          <animateTransform attributeName="transform" type="translate" values="20,20;-40,-40" dur="1.6s" repeatCount="indefinite" begin="0s" />
        </path>

        <path d="M 400 280 C 360 260, 310 240, 260 210" stroke="url(#w1)" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.8s" repeatCount="indefinite" begin="0.3s" />
          <animateTransform attributeName="transform" type="translate" values="15,15;-35,-35" dur="1.8s" repeatCount="indefinite" begin="0.3s" />
        </path>

        <path d="M 350 400 C 310 370, 260 350, 200 330" stroke="url(#w2)" strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0">
          <animate attributeName="opacity" values="0;0.6;0" dur="1.4s" repeatCount="indefinite" begin="0.6s" />
          <animateTransform attributeName="transform" type="translate" values="18,18;-36,-36" dur="1.4s" repeatCount="indefinite" begin="0.6s" />
        </path>

        <path d="M 410 200 C 370 185, 320 170, 270 145" stroke="url(#w1)" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0">
          <animate attributeName="opacity" values="0;0.4;0" dur="2s" repeatCount="indefinite" begin="0.2s" />
          <animateTransform attributeName="transform" type="translate" values="12,12;-30,-30" dur="2s" repeatCount="indefinite" begin="0.2s" />
        </path>

        {/* Shorter speed streaks */}
        <line x1="370" y1="310" x2="320" y2="270" stroke="rgba(180,180,180,0.35)" strokeWidth="1.5" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.6;0" dur="1.1s" repeatCount="indefinite" begin="0.1s" />
          <animateTransform attributeName="transform" type="translate" values="10,10;-25,-25" dur="1.1s" repeatCount="indefinite" begin="0.1s" />
        </line>

        <line x1="390" y1="240" x2="345" y2="205" stroke="rgba(180,180,180,0.3)" strokeWidth="1" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.3s" repeatCount="indefinite" begin="0.5s" />
          <animateTransform attributeName="transform" type="translate" values="8,8;-22,-22" dur="1.3s" repeatCount="indefinite" begin="0.5s" />
        </line>

        <line x1="320" y1="380" x2="275" y2="345" stroke="rgba(255,217,61,0.25)" strokeWidth="1.5" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.5;0" dur="1.5s" repeatCount="indefinite" begin="0.8s" />
          <animateTransform attributeName="transform" type="translate" values="10,10;-28,-28" dur="1.5s" repeatCount="indefinite" begin="0.8s" />
        </line>

        <line x1="400" y1="150" x2="360" y2="120" stroke="rgba(180,180,180,0.25)" strokeWidth="1" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.4;0" dur="1.7s" repeatCount="indefinite" begin="0.4s" />
          <animateTransform attributeName="transform" type="translate" values="8,8;-20,-20" dur="1.7s" repeatCount="indefinite" begin="0.4s" />
        </line>

        {/* Tiny fast dashes */}
        <line x1="340" y1="340" x2="325" y2="328" stroke="rgba(200,200,200,0.3)" strokeWidth="1" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.7;0" dur="0.7s" repeatCount="indefinite" begin="0s" />
          <animateTransform attributeName="transform" type="translate" values="5,5;-15,-15" dur="0.7s" repeatCount="indefinite" begin="0s" />
        </line>

        <line x1="380" y1="180" x2="365" y2="168" stroke="rgba(255,217,61,0.2)" strokeWidth="1" strokeLinecap="round">
          <animate attributeName="opacity" values="0;0.5;0" dur="0.9s" repeatCount="indefinite" begin="0.7s" />
          <animateTransform attributeName="transform" type="translate" values="5,5;-12,-12" dur="0.9s" repeatCount="indefinite" begin="0.7s" />
        </line>
      </svg>

      {/* The bolt image with spin + scale animation */}
      <div className="absolute inset-0 flex items-center justify-center z-10">
        <div className="bolt-spin-scale">
          <Image
            src="/lightning-bolt.png"
            alt="LightMCP"
            width={320}
            height={320}
            className="drop-shadow-[0_4px_20px_rgba(255,200,0,0.25)]"
            priority
          />
        </div>
      </div>
    </div>
  );
}
