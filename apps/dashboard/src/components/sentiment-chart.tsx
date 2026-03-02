interface SentimentEntry {
  turn: number;
  role: "caller" | "agent";
  value: "positive" | "neutral" | "negative";
}

interface SentimentChartProps {
  trajectory: SentimentEntry[];
}

const SENTIMENT_COLOR = {
  positive: "#10b981",
  neutral: "#a1a1aa",
  negative: "#ef4444",
};

const SENTIMENT_Y = {
  positive: 0,
  neutral: 1,
  negative: 2,
};

export function SentimentChart({ trajectory }: SentimentChartProps) {
  if (!trajectory || trajectory.length < 2) return null;

  const callerEntries = trajectory.filter((e) => e.role === "caller");
  const agentEntries = trajectory.filter((e) => e.role === "agent");

  const maxTurn = Math.max(...trajectory.map((e) => e.turn));
  const width = 280;
  const height = 80;
  const padX = 24;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  function toPoint(entry: SentimentEntry) {
    const x = padX + (entry.turn / Math.max(maxTurn, 1)) * innerW;
    const y = padY + (SENTIMENT_Y[entry.value] / 2) * innerH;
    return { x, y, color: SENTIMENT_COLOR[entry.value] };
  }

  function renderLine(entries: SentimentEntry[], dashArray?: string) {
    if (entries.length < 2) return null;
    const points = entries.map(toPoint);
    const pathD = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
      .join(" ");

    return (
      <>
        <path
          d={pathD}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray={dashArray}
          className="text-muted-foreground/30"
        />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3.5} fill={p.color} />
        ))}
      </>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
        Sentiment Trajectory
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="overflow-visible"
      >
        {/* Y-axis labels */}
        <text
          x={2}
          y={padY + 4}
          className="fill-muted-foreground"
          fontSize={8}
        >
          +
        </text>
        <text
          x={2}
          y={padY + innerH / 2 + 3}
          className="fill-muted-foreground"
          fontSize={8}
        >
          ~
        </text>
        <text
          x={2}
          y={padY + innerH + 3}
          className="fill-muted-foreground"
          fontSize={8}
        >
          -
        </text>

        {/* Grid lines */}
        {[0, 1, 2].map((row) => (
          <line
            key={row}
            x1={padX}
            y1={padY + (row / 2) * innerH}
            x2={width - padX}
            y2={padY + (row / 2) * innerH}
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-border"
          />
        ))}

        {/* Lines and dots */}
        {renderLine(callerEntries)}
        {renderLine(agentEntries, "4,3")}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-muted-foreground/30 rounded" />
          <span className="text-[10px] text-muted-foreground">Caller</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-muted-foreground/30 rounded border-t border-dashed" />
          <span className="text-[10px] text-muted-foreground">Agent</span>
        </div>
        <div className="flex items-center gap-3 ml-auto">
          {(["positive", "neutral", "negative"] as const).map((s) => (
            <div key={s} className="flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: SENTIMENT_COLOR[s] }}
              />
              <span className="text-[10px] text-muted-foreground capitalize">
                {s}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
