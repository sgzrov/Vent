"use client";

export function LightningBolt() {
  return (
    <div className="relative w-[420px] h-[520px] select-none">
      <svg
        viewBox="0 0 400 500"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <defs>
          {/* Main bolt gradient */}
          <linearGradient id="boltGrad" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#FFF7CC" />
            <stop offset="30%" stopColor="#FFD93D" />
            <stop offset="60%" stopColor="#F5A623" />
            <stop offset="100%" stopColor="#FF8C00" />
          </linearGradient>

          {/* Inner glow gradient */}
          <linearGradient id="innerGlow" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="50%" stopColor="#FFF3B0" />
            <stop offset="100%" stopColor="#FFD93D" />
          </linearGradient>

          {/* Outer glow filter */}
          <filter id="boltGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="blur1" />
            <feFlood floodColor="#FFD93D" floodOpacity="0.6" result="color" />
            <feComposite in="color" in2="blur1" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Intense inner glow */}
          <filter id="innerBoltGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feFlood floodColor="#FFFFFF" floodOpacity="0.8" result="white" />
            <feComposite in="white" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Spark glow */}
          <filter id="sparkGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feFlood floodColor="#FFD93D" floodOpacity="0.9" result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Ambient glow */}
          <radialGradient id="ambientGlow" cx="0.5" cy="0.45" r="0.5">
            <stop offset="0%" stopColor="#FFD93D" stopOpacity="0.15">
              <animate attributeName="stopOpacity" values="0.15;0.25;0.15" dur="2s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#FFD93D" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ambient background glow */}
        <ellipse cx="200" cy="230" rx="180" ry="220" fill="url(#ambientGlow)">
          <animate attributeName="rx" values="180;195;180" dur="3s" repeatCount="indefinite" />
          <animate attributeName="ry" values="220;235;220" dur="3s" repeatCount="indefinite" />
        </ellipse>

        {/* === MAIN BOLT SHAPE === */}
        <g filter="url(#boltGlow)">
          {/* Outer bolt body */}
          <path
            d="M 230 20 L 150 195 L 205 195 L 130 380 L 175 380 L 115 480 L 300 260 L 240 260 L 320 100 L 255 100 Z"
            fill="url(#boltGrad)"
            stroke="#E8A317"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            <animate attributeName="opacity" values="1;0.85;1;0.95;1" dur="0.15s" repeatCount="indefinite" />
          </path>

          {/* Inner bright core */}
          <path
            d="M 225 40 L 160 190 L 205 190 L 145 360 L 180 360 L 135 450 L 280 265 L 238 265 L 305 115 L 253 115 Z"
            fill="url(#innerGlow)"
            filter="url(#innerBoltGlow)"
            opacity="0.7"
          >
            <animate attributeName="opacity" values="0.7;0.5;0.8;0.6;0.7" dur="0.2s" repeatCount="indefinite" />
          </path>

          {/* White-hot center line */}
          <path
            d="M 222 55 L 168 188 L 203 188 L 155 345 L 182 345 L 150 430 L 265 268 L 237 268 L 295 125 L 252 125 Z"
            fill="white"
            opacity="0.35"
          >
            <animate attributeName="opacity" values="0.35;0.15;0.4;0.2;0.35" dur="0.12s" repeatCount="indefinite" />
          </path>
        </g>

        {/* === CRACKLING ENERGY BRANCHES === */}
        <g filter="url(#sparkGlow)" opacity="0.8">
          {/* Top-right branch */}
          <polyline
            points="280,85 310,65 325,75 345,50"
            stroke="#FFD93D"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0;0.9;0;0.7;0;0.5;0" dur="0.8s" repeatCount="indefinite" />
            <animate attributeName="stroke-width" values="2.5;1;2.5" dur="0.4s" repeatCount="indefinite" />
          </polyline>

          {/* Top-left branch */}
          <polyline
            points="195,120 170,100 155,110 135,85"
            stroke="#FFE066"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0.6;0;0.8;0;0.3;0" dur="0.6s" repeatCount="indefinite" />
          </polyline>

          {/* Mid-right branch */}
          <polyline
            points="260,230 290,220 305,235 330,215"
            stroke="#FFD93D"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0;0.5;0;0.9;0;0.3;0" dur="0.9s" repeatCount="indefinite" />
          </polyline>

          {/* Mid-left branch */}
          <polyline
            points="170,280 140,275 130,290 105,280"
            stroke="#FFE066"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0.4;0;0.7;0;0;0.6;0" dur="0.7s" repeatCount="indefinite" />
          </polyline>

          {/* Bottom-right branch */}
          <polyline
            points="220,340 245,355 260,340 280,360"
            stroke="#FFD93D"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0;0.8;0;0;0.6;0" dur="1s" repeatCount="indefinite" />
          </polyline>

          {/* Bottom-left branch */}
          <polyline
            points="155,400 130,410 120,395 95,405"
            stroke="#FFE066"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <animate attributeName="opacity" values="0.3;0;0;0.9;0;0.4;0" dur="0.85s" repeatCount="indefinite" />
          </polyline>
        </g>

        {/* === SPARKS / PARTICLES === */}
        <g filter="url(#sparkGlow)">
          {/* Spark 1 - top */}
          <circle cx="310" cy="60" r="2.5" fill="#FFFFFF">
            <animate attributeName="cx" values="310;320;310" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="cy" values="60;45;60" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0;1;0" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="r" values="2.5;1;2.5" dur="1.5s" repeatCount="indefinite" />
          </circle>

          {/* Spark 2 - right */}
          <circle cx="340" cy="140" r="2" fill="#FFD93D">
            <animate attributeName="cx" values="340;355;340" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
            <animate attributeName="cy" values="140;130;140" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
            <animate attributeName="opacity" values="0;0.8;0" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
          </circle>

          {/* Spark 3 - left */}
          <circle cx="100" cy="200" r="2" fill="#FFFFFF">
            <animate attributeName="cx" values="100;85;100" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
            <animate attributeName="cy" values="200;190;200" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
            <animate attributeName="opacity" values="0;1;0" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
          </circle>

          {/* Spark 4 - mid right */}
          <circle cx="335" cy="230" r="1.5" fill="#FFE066">
            <animate attributeName="cx" values="335;348;335" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
            <animate attributeName="cy" values="230;218;230" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
            <animate attributeName="opacity" values="0;0.9;0" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
          </circle>

          {/* Spark 5 - bottom */}
          <circle cx="130" cy="430" r="2" fill="#FFD93D">
            <animate attributeName="cx" values="130;115;130" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
            <animate attributeName="cy" values="430;418;430" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
            <animate attributeName="opacity" values="0;0.7;0" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
          </circle>

          {/* Spark 6 - top left */}
          <circle cx="145" cy="90" r="1.5" fill="#FFFFFF">
            <animate attributeName="cx" values="145;130;145" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
            <animate attributeName="cy" values="90;78;90" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
            <animate attributeName="opacity" values="0;1;0" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
          </circle>

          {/* Spark 7 - mid */}
          <circle cx="260" cy="310" r="2" fill="#FFE066">
            <animate attributeName="cx" values="260;275;260" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
            <animate attributeName="cy" values="310;298;310" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
            <animate attributeName="opacity" values="0;0.85;0" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
          </circle>
        </g>

        {/* === ELECTRIC ARC FLASHES === */}
        <g opacity="0.6">
          {/* Flash 1 */}
          <ellipse cx="220" cy="150" rx="40" ry="15" fill="white" opacity="0">
            <animate attributeName="opacity" values="0;0.3;0" dur="3s" repeatCount="indefinite" begin="0s" />
            <animate attributeName="rx" values="40;55;40" dur="3s" repeatCount="indefinite" begin="0s" />
          </ellipse>

          {/* Flash 2 */}
          <ellipse cx="180" cy="320" rx="30" ry="10" fill="#FFD93D" opacity="0">
            <animate attributeName="opacity" values="0;0.25;0" dur="2.5s" repeatCount="indefinite" begin="1.2s" />
            <animate attributeName="rx" values="30;45;30" dur="2.5s" repeatCount="indefinite" begin="1.2s" />
          </ellipse>
        </g>
      </svg>
    </div>
  );
}
