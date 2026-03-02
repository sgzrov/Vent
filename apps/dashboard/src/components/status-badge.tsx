import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  size?: "sm" | "lg";
}

const statusConfig: Record<string, { label: string; className: string }> = {
  queued: {
    label: "Queued",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  running: {
    label: "Running",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  pass: {
    label: "Pass",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  fail: {
    label: "Fail",
    className: "bg-red-50 text-red-700 border-red-200",
  },
};

export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground",
  };

  return (
    <Badge
      variant="outline"
      className={cn(
        config.className,
        size === "lg" && "text-xs px-2.5 py-0.5"
      )}
    >
      {status === "running" && (
        <span className="mr-1.5 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
      )}
      {config.label}
    </Badge>
  );
}
