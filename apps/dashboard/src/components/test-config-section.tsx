"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TestSpec, CallerPersona } from "@/lib/types";

interface TestConfigSectionProps {
  testSpec: TestSpec;
}

const AUDIO_TEST_LABELS: Record<string, string> = {
  echo: "Echo Detection",
  barge_in: "Barge-in Handling",
  ttfb: "Time to First Byte",
  silence_handling: "Silence Handling",
  connection_stability: "Connection Stability",
  response_completeness: "Response Completeness",
  noise_resilience: "Noise Resilience",
  endpointing: "Endpointing",
  audio_quality: "Audio Quality",
};

const RED_TEAM_LABELS: Record<string, string> = {
  prompt_injection: "Prompt Injection",
  pii_extraction: "PII Extraction",
  jailbreak: "Jailbreak",
  social_engineering: "Social Engineering",
  off_topic: "Off-Topic",
  compliance_bypass: "Compliance Bypass",
};

function PersonaBadges({ persona }: { persona: CallerPersona }) {
  const traits: string[] = [];
  if (persona.pace && persona.pace !== "normal") traits.push(persona.pace);
  if (persona.clarity && persona.clarity !== "clear") traits.push(persona.clarity);
  if (persona.disfluencies) traits.push("disfluencies");
  if (persona.cooperation && persona.cooperation !== "cooperative") traits.push(persona.cooperation);
  if (persona.emotion && persona.emotion !== "neutral") traits.push(persona.emotion);
  if (persona.interruption_style && persona.interruption_style !== "none") traits.push(`${persona.interruption_style} interrupts`);
  if (persona.memory === "unreliable") traits.push("unreliable memory");
  if (persona.intent_clarity && persona.intent_clarity !== "clear") traits.push(`${persona.intent_clarity} intent`);
  if (persona.confirmation_style === "vague") traits.push("vague confirmations");

  if (traits.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {traits.map((trait) => (
        <span
          key={trait}
          className="inline-flex items-center rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-mono"
        >
          {trait}
        </span>
      ))}
    </div>
  );
}

export function TestConfigSection({ testSpec }: TestConfigSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const hasAudio = testSpec.audio_tests && testSpec.audio_tests.length > 0;
  const hasConversation =
    testSpec.conversation_tests && testSpec.conversation_tests.length > 0;
  const hasRedTeam = testSpec.red_team && testSpec.red_team.length > 0;

  if (!hasAudio && !hasConversation && !hasRedTeam) return null;

  return (
    <div className="rounded-md border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium hover:bg-accent/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        Test Configuration
        <span className="text-xs text-muted-foreground font-normal ml-auto">
          {[
            hasAudio && `${testSpec.audio_tests!.length} audio`,
            hasConversation &&
              `${testSpec.conversation_tests!.length} conversation`,
            hasRedTeam && `${testSpec.red_team!.length} red-team`,
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t">
          {hasAudio && (
            <div className="pt-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Audio Tests
              </p>
              <div className="flex flex-wrap gap-1.5">
                {testSpec.audio_tests!.map((test) => (
                  <span
                    key={test}
                    className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                  >
                    {AUDIO_TEST_LABELS[test] ?? test}
                  </span>
                ))}
              </div>
            </div>
          )}

          {hasConversation && (
            <div className="pt-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Conversation Tests
              </p>
              <div className="space-y-3">
                {testSpec.conversation_tests!.map((test, i) => (
                  <div key={i} className="rounded-md bg-muted/50 p-3">
                    <p className="text-sm font-medium">
                      {test.name ?? `Test ${i + 1}`}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 italic">
                      &ldquo;{test.caller_prompt}&rdquo;
                    </p>
                    <span className="text-[10px] text-muted-foreground mt-1 inline-block">
                      Max {test.max_turns} turns
                    </span>
                    {test.persona && <PersonaBadges persona={test.persona} />}
                    {test.eval.length > 0 && (
                      <div className="mt-2">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                          Eval questions
                        </p>
                        <ul className="space-y-0.5">
                          {test.eval.map((q, j) => (
                            <li
                              key={j}
                              className="text-xs text-muted-foreground"
                            >
                              {q}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasRedTeam && (
            <div className="pt-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Red-Team Attacks
              </p>
              <div className="flex flex-wrap gap-1.5">
                {testSpec.red_team!.map((attack) => (
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
      )}
    </div>
  );
}
