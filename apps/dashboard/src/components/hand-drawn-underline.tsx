"use client";

export function HandDrawnUnderline() {
  return (
    <svg
      viewBox="0 0 180 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="absolute -bottom-2 left-0 w-full h-[12px]"
      preserveAspectRatio="none"
    >
      <path
        d="M 2 8 C 20 3, 35 10, 55 6 C 75 2, 90 9, 110 5 C 130 1, 150 8, 178 4"
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
