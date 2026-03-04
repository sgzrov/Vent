import { Card, CardContent } from "@/components/ui/card";
import type { RunAggregateV2, TestSpec } from "@/lib/types";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AUDIO_TEST_REGISTRY, RED_TEAM_LABELS } from "@/lib/audio-test-registry";

interface MetricCardsProps {
  aggregate: RunAggregateV2;
  testSpec?: TestSpec | null;
}

/** Resolve infrastructure stats, falling back to legacy audio_tests field. */
function getInfraStats(agg: RunAggregateV2) {
  if (agg.infrastructure) return agg.infrastructure;
  // Legacy aggregate from historical runs
  if (agg.audio_tests) {
    return {
      total: agg.audio_tests.total,
      completed: agg.audio_tests.passed,
      errored: agg.audio_tests.failed,
    };
  }
  return { total: 0, completed: 0, errored: 0 };
}

export function MetricCards({ aggregate, testSpec }: MetricCardsProps) {
  const infra = getInfraStats(aggregate);
  const hasInfra = infra.total > 0;
  const hasConversation = aggregate.conversation_tests.total > 0;
  const hasConfig =
    (testSpec?.audio_tests?.length ?? 0) > 0 ||
    (testSpec?.conversation_tests?.length ?? 0) > 0 ||
    (testSpec?.red_team?.length ?? 0) > 0;

  const primary = hasInfra
    ? {
        label: "Infrastructure probes",
        value: `${infra.completed}/${infra.total}`,
        errored: infra.errored,
      }
    : {
        label: "Conversation tests",
        value: `${aggregate.conversation_tests.passed}/${aggregate.conversation_tests.total}`,
        errored: aggregate.conversation_tests.failed,
      };

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3",
        hasConfig && "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
      )}
    >
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                {primary.label}
              </p>
              <p className="text-[1.4rem] leading-none font-semibold mt-1 tabular-nums">
                {primary.value}
              </p>
            </div>

            <span className="hidden sm:block h-8 w-px bg-border" />

            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                Status
              </p>
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium mt-1",
                  primary.errored > 0
                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                )}
              >
                {hasInfra
                  ? primary.errored > 0
                    ? `${primary.errored} errored`
                    : "All completed"
                  : primary.errored > 0
                    ? `${primary.errored} failed`
                    : "All passed"}
              </span>
            </div>

            <span className="hidden sm:block h-8 w-px bg-border" />

            <div>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                Duration
              </p>
              <p className="text-[1.4rem] leading-none font-semibold mt-1 tabular-nums">
                {formatDuration(aggregate.total_duration_ms)}
              </p>
            </div>

            {hasInfra && hasConversation && (
              <p className="text-xs text-muted-foreground ml-auto">
                Conversation: {aggregate.conversation_tests.passed}/
                {aggregate.conversation_tests.total}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {hasConfig && (
        <Card>
          <CardContent className="py-4">
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
                Tests Run
              </p>

              {(testSpec?.audio_tests?.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Infrastructure
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {testSpec!.audio_tests!.map((test) => (
                      <span
                        key={test}
                        className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                      >
                        {AUDIO_TEST_REGISTRY[test as keyof typeof AUDIO_TEST_REGISTRY]?.label ?? test}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {(testSpec?.conversation_tests?.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Conversations
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {testSpec!.conversation_tests!.map((test, i) => (
                      <span
                        key={`${test.name ?? "conversation"}-${i}`}
                        className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                      >
                        {test.name ?? `Conversation ${i + 1}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {(testSpec?.red_team?.length ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Security
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {testSpec!.red_team!.map((attack) => (
                      <span
                        key={attack}
                        className="inline-flex items-center rounded-md bg-red-500/10 text-red-600 dark:text-red-400 px-2 py-0.5 text-xs font-mono"
                      >
                        {RED_TEAM_LABELS[attack] ?? attack}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
