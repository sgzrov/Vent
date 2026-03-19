"use client";

export function HandDrawnUnderline() {
  return (
    <svg
      viewBox="0 0 200 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="absolute -bottom-1 -left-[2%] w-[104%] h-[10px]"
      preserveAspectRatio="none"
    >
      <path
        d="M 2 6 C 30 4, 50 7, 80 5.5 C 110 4, 140 7, 198 5"
        stroke="url(#underlineGrad)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        className="draw-underline"
      />
      <defs>
        <linearGradient id="underlineGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FACC15" />
          <stop offset="50%" stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#EAB308" />
        </linearGradient>
      </defs>
    </svg>
  );
}
