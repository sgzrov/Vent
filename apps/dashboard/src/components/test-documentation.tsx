"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, BookOpen } from "lucide-react";
import { AUDIO_TEST_REGISTRY } from "@/lib/audio-test-registry";

export function TestDocumentation() {
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<string | null>(null);

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
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        How We Test
        <span className="text-xs text-muted-foreground font-normal ml-auto">
          Methodology &amp; Transparency
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t space-y-1 animate-fade-in">
          {/* Audio Tests */}
          <button
            onClick={() =>
              setSection(section === "audio" ? null : "audio")
            }
            className="flex items-center gap-2 w-full py-2.5 text-sm hover:bg-accent/20 rounded-md px-2 transition-colors"
          >
            {section === "audio" ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-medium">Audio Tests</span>
            <span className="text-xs text-muted-foreground">
              9 infrastructure-level tests
            </span>
          </button>
          {section === "audio" && (
            <div className="space-y-3 pl-6 pb-3">
              {Object.values(AUDIO_TEST_REGISTRY).map((test) => (
                <div
                  key={test.key}
                  className="rounded-md bg-muted/30 p-3"
                >
                  <p className="text-sm font-medium">{test.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {test.description}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    <span className="font-medium text-foreground">
                      How:
                    </span>{" "}
                    {test.methodology}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    <span className="font-medium text-foreground">
                      Pass criteria:
                    </span>{" "}
                    {test.passCriteria}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Conversation Tests */}
          <button
            onClick={() =>
              setSection(section === "conversation" ? null : "conversation")
            }
            className="flex items-center gap-2 w-full py-2.5 text-sm hover:bg-accent/20 rounded-md px-2 transition-colors"
          >
            {section === "conversation" ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-medium">Conversation Tests</span>
            <span className="text-xs text-muted-foreground">
              LLM-driven multi-turn evaluation
            </span>
          </button>
          {section === "conversation" && (
            <div className="space-y-3 pl-6 pb-3">
              <div className="rounded-md bg-muted/30 p-3 space-y-2">
                <p className="text-sm font-medium">
                  How Conversation Tests Work
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  VoiceCI simulates a real caller using an LLM-driven persona.
                  Each turn follows this pipeline:
                </p>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>
                    <span className="font-medium text-foreground">
                      Caller LLM
                    </span>{" "}
                    generates a natural utterance based on the persona and
                    conversation context
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      TTS Synthesis
                    </span>{" "}
                    (ElevenLabs) converts text to natural speech audio
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      Audio Channel
                    </span>{" "}
                    sends the PCM audio to your agent
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      VAD Collection
                    </span>{" "}
                    (Voice Activity Detection) identifies when the agent
                    finishes speaking
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      STT Transcription
                    </span>{" "}
                    (Deepgram) converts the agent&apos;s audio response to text
                  </li>
                  <li>Repeat until max turns or natural conversation end</li>
                </ol>
              </div>
              <div className="rounded-md bg-muted/30 p-3 space-y-2">
                <p className="text-sm font-medium">
                  Evaluation: LLM-as-Judge
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  After the conversation completes, a judge LLM (Claude)
                  evaluates the transcript against your evaluation criteria.
                  For each criterion, the judge determines:
                </p>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>
                    <span className="font-medium text-foreground">
                      Relevancy
                    </span>{" "}
                    — Was this criterion actually testable in the conversation?
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      Pass/Fail
                    </span>{" "}
                    — Did the agent meet the criterion?
                  </li>
                  <li>
                    <span className="font-medium text-foreground">
                      Reasoning
                    </span>{" "}
                    — Cited evidence from the transcript explaining the
                    judgment
                  </li>
                </ul>
              </div>
              <div className="rounded-md bg-muted/30 p-3 space-y-2">
                <p className="text-sm font-medium">Behavioral Metrics</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  In parallel, the judge evaluates behavioral dimensions:
                  intent accuracy, context retention, clarity, empathy,
                  topic drift, sentiment trajectory, hallucination detection,
                  safety compliance, and escalation handling. Each receives a
                  0-1 score with reasoning.
                </p>
              </div>
              <div className="rounded-md bg-muted/30 p-3 space-y-2">
                <p className="text-sm font-medium">Audio Analysis</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  VoiceCI uses batch VAD (Voice Activity Detection) on the
                  agent&apos;s audio to compute: speech ratio, talk ratio,
                  longest monologue, silence gaps, and per-turn speech
                  segmentation. These metrics help identify agents that
                  monologue, produce choppy audio, or leave excessive silence.
                </p>
              </div>
            </div>
          )}

          {/* Red Team */}
          <button
            onClick={() =>
              setSection(section === "redteam" ? null : "redteam")
            }
            className="flex items-center gap-2 w-full py-2.5 text-sm hover:bg-accent/20 rounded-md px-2 transition-colors"
          >
            {section === "redteam" ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-medium">Security Tests</span>
            <span className="text-xs text-muted-foreground">
              6 adversarial attack categories
            </span>
          </button>
          {section === "redteam" && (
            <div className="space-y-3 pl-6 pb-3">
              {[
                {
                  name: "Prompt Injection",
                  desc: "Attempts to extract the system prompt or override the agent's role and instructions.",
                },
                {
                  name: "PII Extraction",
                  desc: "Tries to get the agent to reveal information about other customers or internal systems.",
                },
                {
                  name: "Jailbreak",
                  desc: "Uses hypothetical scenarios or gradual boundary pushing to bypass the agent's guardrails.",
                },
                {
                  name: "Social Engineering",
                  desc: "Impersonates authority figures or creates artificial urgency to manipulate the agent.",
                },
                {
                  name: "Off-Topic",
                  desc: "Pulls the agent off its designated domain or tries to extract personal opinions.",
                },
                {
                  name: "Compliance Bypass",
                  desc: "Pressures the agent to skip verification steps or make policy exceptions.",
                },
              ].map((attack) => (
                <div
                  key={attack.name}
                  className="rounded-md bg-muted/30 p-3"
                >
                  <p className="text-sm font-medium">{attack.name}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {attack.desc}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Scoring Methodology */}
          <button
            onClick={() =>
              setSection(section === "scoring" ? null : "scoring")
            }
            className="flex items-center gap-2 w-full py-2.5 text-sm hover:bg-accent/20 rounded-md px-2 transition-colors"
          >
            {section === "scoring" ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="font-medium">Scoring</span>
            <span className="text-xs text-muted-foreground">
              How pass/fail is determined
            </span>
          </button>
          {section === "scoring" && (
            <div className="space-y-3 pl-6 pb-3">
              <div className="rounded-md bg-muted/30 p-3 space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground">
                    Audio tests
                  </span>{" "}
                  pass or fail based on configurable thresholds (e.g., P95
                  TTFB &lt; 1500ms, no echo detected). These are deterministic.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground">
                    Conversation tests
                  </span>{" "}
                  pass when all relevant evaluation criteria pass. Each
                  criterion is judged by an LLM (Claude Sonnet) with
                  temperature 0 for consistency.
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground">
                    A run passes
                  </span>{" "}
                  when every individual test passes. Any single failure marks
                  the entire run as failed.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
