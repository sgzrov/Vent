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
          <linearGradient id="boltGrad" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#FFF7CC" />
            <stop offset="30%" stopColor="#FFD93D" />
            <stop offset="60%" stopColor="#F5A623" />
            <stop offset="100%" stopColor="#FF8C00" />
          </linearGradient>

          <linearGradient id="innerGlow" x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="50%" stopColor="#FFF3B0" />
            <stop offset="100%" stopColor="#FFD93D" />
          </linearGradient>

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

          <filter id="innerBoltGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feFlood floodColor="#FFFFFF" floodOpacity="0.8" result="white" />
            <feComposite in="white" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

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

          <filter id="whirlGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feFlood floodColor="#FFD93D" floodOpacity="0.5" result="color" />
            <feComposite in="color" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

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

        {/* === WIND WHIRLS === */}
        <g filter="url(#whirlGlow)">
          <path d="M 290 60 C 350 80, 360 150, 310 180" stroke="#FFD93D" strokeWidth="2" strokeLinecap="round" fill="none" strokeDasharray="120" strokeDashoffset="120">
            <animate attributeName="stroke-dashoffset" values="120;0;-120" dur="2s" repeatCount="indefinite" begin="0s" />
            <animate attributeName="opacity" values="0;0.6;0.6;0" dur="2s" repeatCount="indefinite" begin="0s" />
          </path>

          <path d="M 110 120 C 60 140, 50 210, 100 250" stroke="#FFE066" strokeWidth="1.5" strokeLinecap="round" fill="none" strokeDasharray="130" strokeDashoffset="130">
            <animate attributeName="stroke-dashoffset" values="130;0;-130" dur="2.4s" repeatCount="indefinite" begin="0.5s" />
            <animate attributeName="opacity" values="0;0.5;0.5;0" dur="2.4s" repeatCount="indefinite" begin="0.5s" />
          </path>

          <path d="M 320 220 C 355 240, 340 290, 300 300 C 270 310, 260 280, 280 265" stroke="#FFD93D" strokeWidth="1.5" strokeLinecap="round" fill="none" strokeDasharray="160" strokeDashoffset="160">
            <animate attributeName="stroke-dashoffset" values="160;0;-160" dur="2.8s" repeatCount="indefinite" begin="0.3s" />
            <animate attributeName="opacity" values="0;0.5;0.4;0" dur="2.8s" repeatCount="indefinite" begin="0.3s" />
          </path>

          <path d="M 80 340 C 50 370, 70 420, 120 430" stroke="#FFE066" strokeWidth="2" strokeLinecap="round" fill="none" strokeDasharray="110" strokeDashoffset="110">
            <animate attributeName="stroke-dashoffset" values="110;0;-110" dur="2.2s" repeatCount="indefinite" begin="0.8s" />
            <animate attributeName="opacity" values="0;0.55;0.55;0" dur="2.2s" repeatCount="indefinite" begin="0.8s" />
          </path>

          <path d="M 160 40 C 120 20, 70 50, 65 100" stroke="#FFD93D" strokeWidth="1.5" strokeLinecap="round" fill="none" strokeDasharray="100" strokeDashoffset="100">
            <animate attributeName="stroke-dashoffset" values="100;0;-100" dur="1.8s" repeatCount="indefinite" begin="1.2s" />
            <animate attributeName="opacity" values="0;0.45;0.45;0" dur="1.8s" repeatCount="indefinite" begin="1.2s" />
          </path>

          <path d="M 280 380 C 330 390, 350 430, 310 460" stroke="#FFE066" strokeWidth="1.5" strokeLinecap="round" fill="none" strokeDasharray="100" strokeDashoffset="100">
            <animate attributeName="stroke-dashoffset" values="100;0;-100" dur="2.6s" repeatCount="indefinite" begin="0.2s" />
            <animate attributeName="opacity" values="0;0.4;0.4;0" dur="2.6s" repeatCount="indefinite" begin="0.2s" />
          </path>
        </g>

        {/* === SPEED LINES === */}
        <g opacity="0.35">
          <line x1="95" y1="100" x2="110" y2="60" stroke="#c4c4c4" strokeWidth="1.5" strokeLinecap="round">
            <animate attributeName="opacity" values="0;0.5;0" dur="1.2s" repeatCount="indefinite" begin="0s" />
            <animateTransform attributeName="transform" type="translate" values="0,20;0,-30" dur="1.2s" repeatCount="indefinite" begin="0s" />
          </line>
          <line x1="320" y1="130" x2="340" y2="85" stroke="#c4c4c4" strokeWidth="1.5" strokeLinecap="round">
            <animate attributeName="opacity" values="0;0.4;0" dur="1.5s" repeatCount="indefinite" begin="0.3s" />
            <animateTransform attributeName="transform" type="translate" values="0,15;0,-35" dur="1.5s" repeatCount="indefinite" begin="0.3s" />
          </line>
          <line x1="70" y1="280" x2="85" y2="240" stroke="#c4c4c4" strokeWidth="1" strokeLinecap="round">
            <animate attributeName="opacity" values="0;0.4;0" dur="1.3s" repeatCount="indefinite" begin="0.7s" />
            <animateTransform attributeName="transform" type="translate" values="0,15;0,-25" dur="1.3s" repeatCount="indefinite" begin="0.7s" />
          </line>
          <line x1="340" y1="330" x2="355" y2="290" stroke="#c4c4c4" strokeWidth="1" strokeLinecap="round">
            <animate attributeName="opacity" values="0;0.35;0" dur="1.7s" repeatCount="indefinite" begin="0.5s" />
            <animateTransform attributeName="transform" type="translate" values="0,12;0,-28" dur="1.7s" repeatCount="indefinite" begin="0.5s" />
          </line>
        </g>

        {/* === MAIN BOLT — tilted horizontally === */}
        <g transform="rotate(25, 200, 250)">
          <g filter="url(#boltGlow)">
            <path
              d="M 230 20 L 150 195 L 205 195 L 130 380 L 175 380 L 115 480 L 300 260 L 240 260 L 320 100 L 255 100 Z"
              fill="url(#boltGrad)"
              stroke="#E8A317"
              strokeWidth="2"
              strokeLinejoin="round"
            >
              <animate attributeName="opacity" values="1;0.88;1;0.92;1" dur="0.15s" repeatCount="indefinite" />
            </path>

            <path
              d="M 225 40 L 160 190 L 205 190 L 145 360 L 180 360 L 135 450 L 280 265 L 238 265 L 305 115 L 253 115 Z"
              fill="url(#innerGlow)"
              filter="url(#innerBoltGlow)"
              opacity="0.7"
            >
              <animate attributeName="opacity" values="0.7;0.5;0.8;0.6;0.7" dur="0.2s" repeatCount="indefinite" />
            </path>

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
            <polyline points="280,85 310,65 325,75 345,50" stroke="#FFD93D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0;0.9;0;0.7;0;0.5;0" dur="0.8s" repeatCount="indefinite" />
              <animate attributeName="stroke-width" values="2.5;1;2.5" dur="0.4s" repeatCount="indefinite" />
            </polyline>

            <polyline points="195,120 170,100 155,110 135,85" stroke="#FFE066" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0.6;0;0.8;0;0.3;0" dur="0.6s" repeatCount="indefinite" />
            </polyline>

            <polyline points="260,230 290,220 305,235 330,215" stroke="#FFD93D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0;0.5;0;0.9;0;0.3;0" dur="0.9s" repeatCount="indefinite" />
            </polyline>

            <polyline points="170,280 140,275 130,290 105,280" stroke="#FFE066" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0.4;0;0.7;0;0;0.6;0" dur="0.7s" repeatCount="indefinite" />
            </polyline>

            <polyline points="220,340 245,355 260,340 280,360" stroke="#FFD93D" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0;0.8;0;0;0.6;0" dur="1s" repeatCount="indefinite" />
            </polyline>

            <polyline points="155,400 130,410 120,395 95,405" stroke="#FFE066" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <animate attributeName="opacity" values="0.3;0;0;0.9;0;0.4;0" dur="0.85s" repeatCount="indefinite" />
            </polyline>
          </g>

          {/* === SPARKS === */}
          <g filter="url(#sparkGlow)">
            <circle cx="310" cy="60" r="2.5" fill="#FFFFFF">
              <animate attributeName="cx" values="310;320;310" dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="cy" values="60;45;60" dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;1;0" dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="r" values="2.5;1;2.5" dur="1.5s" repeatCount="indefinite" />
            </circle>

            <circle cx="340" cy="140" r="2" fill="#FFD93D">
              <animate attributeName="cx" values="340;355;340" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
              <animate attributeName="cy" values="140;130;140" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
              <animate attributeName="opacity" values="0;0.8;0" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
            </circle>

            <circle cx="100" cy="200" r="2" fill="#FFFFFF">
              <animate attributeName="cx" values="100;85;100" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="cy" values="200;190;200" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="opacity" values="0;1;0" dur="1.8s" repeatCount="indefinite" begin="0.6s" />
            </circle>

            <circle cx="335" cy="230" r="1.5" fill="#FFE066">
              <animate attributeName="cx" values="335;348;335" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
              <animate attributeName="cy" values="230;218;230" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
              <animate attributeName="opacity" values="0;0.9;0" dur="1.4s" repeatCount="indefinite" begin="0.1s" />
            </circle>

            <circle cx="130" cy="430" r="2" fill="#FFD93D">
              <animate attributeName="cx" values="130;115;130" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
              <animate attributeName="cy" values="430;418;430" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
              <animate attributeName="opacity" values="0;0.7;0" dur="1.6s" repeatCount="indefinite" begin="0.8s" />
            </circle>

            <circle cx="145" cy="90" r="1.5" fill="#FFFFFF">
              <animate attributeName="cx" values="145;130;145" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
              <animate attributeName="cy" values="90;78;90" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
              <animate attributeName="opacity" values="0;1;0" dur="1.3s" repeatCount="indefinite" begin="0.4s" />
            </circle>

            <circle cx="260" cy="310" r="2" fill="#FFE066">
              <animate attributeName="cx" values="260;275;260" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
              <animate attributeName="cy" values="310;298;310" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
              <animate attributeName="opacity" values="0;0.85;0" dur="1.1s" repeatCount="indefinite" begin="0.5s" />
            </circle>
          </g>
        </g>

        {/* === ELECTRIC ARC FLASHES === */}
        <g opacity="0.6">
          <ellipse cx="220" cy="150" rx="40" ry="15" fill="white" opacity="0">
            <animate attributeName="opacity" values="0;0.3;0" dur="3s" repeatCount="indefinite" begin="0s" />
            <animate attributeName="rx" values="40;55;40" dur="3s" repeatCount="indefinite" begin="0s" />
          </ellipse>

          <ellipse cx="180" cy="320" rx="30" ry="10" fill="#FFD93D" opacity="0">
            <animate attributeName="opacity" values="0;0.25;0" dur="2.5s" repeatCount="indefinite" begin="1.2s" />
            <animate attributeName="rx" values="30;45;30" dur="2.5s" repeatCount="indefinite" begin="1.2s" />
          </ellipse>
        </g>
      </svg>
    </div>
  );
}
