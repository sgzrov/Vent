import { cn } from "@/lib/utils";
import type { EvalResult } from "@/lib/types";

interface EvalResultsProps {
  evalResults: EvalResult[];
  toolCallEvalResults?: EvalResult[];
}

function EvalRow({ eval_ }: { eval_: EvalResult }) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        eval_.passed
          ? "border-emerald-500/20 bg-emerald-500/5"
          : "border-red-500/20 bg-red-500/5"
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-1 h-2.5 w-2.5 rounded-full shrink-0",
            eval_.passed ? "bg-emerald-500" : "bg-red-500"
          )}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{eval_.question}</p>
          {!eval_.relevant && (
            <span className="text-xs text-muted-foreground italic">
              Not relevant to this conversation
            </span>
          )}
          {eval_.relevant && eval_.reasoning && (
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              {eval_.reasoning}
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 text-xs font-medium px-2 py-0.5 rounded",
            eval_.passed
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-red-700 dark:text-red-400"
          )}
        >
          {eval_.passed ? "PASS" : "FAIL"}
        </span>
      </div>
    </div>
  );
}

export function EvalResults({
  evalResults,
  toolCallEvalResults,
}: EvalResultsProps) {
  return (
    <div className="space-y-4">
      {evalResults.length > 0 && (
        <div className="space-y-2">
          {evalResults.map((eval_, i) => (
            <EvalRow key={i} eval_={eval_} />
          ))}
        </div>
      )}

      {toolCallEvalResults && toolCallEvalResults.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 mt-4">
            Tool Call Evals
          </h4>
          <div className="space-y-2">
            {toolCallEvalResults.map((eval_, i) => (
              <EvalRow key={i} eval_={eval_} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
