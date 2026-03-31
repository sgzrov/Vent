/**
 * Caller LLM — generates dynamic caller utterances from a persona prompt.
 *
 * Uses Anthropic Haiku for speed. Maintains conversation history
 * and returns a structured decision for whether the call should continue.
 *
 * Optional CallerPersona injects behavioral modifiers into the system prompt,
 * keeping persona traits (HOW the caller behaves) separate from the caller_prompt
 * (WHAT the caller wants).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ConversationTurn, CallerPersona } from "@vent/shared";
import { LANGUAGE_NAMES } from "@vent/voice";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 80;

const SYSTEM_PROMPT = `You are a simulated phone caller. Your persona and goals are defined in the user's first message.

Rules:
- Priority order:
  1. If the agent asks a direct question, gives a yes/no choice, or explicitly requests information, do not use "wait". Answer briefly right away.
  2. If the agent has already resolved the request, is wrapping up, or promises a later follow-up or callback, do not use "wait". Use "closing" with a brief natural close.
  3. Only use "wait" when the agent is still working, checking, apologizing, transferring, or continuing their thought and no real answer is needed from you yet.
- Return JSON only.
- Use one of these shapes:
  {"mode":"continue","text":"your next spoken line"}
  {"mode":"wait"}
  {"mode":"closing","text":"your final spoken line before the call ends"}
  {"mode":"end_now"}
- The text field must contain ONLY the exact spoken line — no stage directions, no quotes, no labels.
- Stay in character. Be natural and conversational.
- The agent's last turn may contain duplicates, stutters, filler, partial repeated clauses, or mixed thoughts due to voice-call segmentation. Infer the clearest intended meaning before deciding how to respond.
- If the agent turn contains one clear actionable question/request plus extra filler, repeated text, or courtesy chatter, respond only to the actionable part.
- If the agent turn is incomplete, self-contradictory, or still sounds like the agent is continuing the same thought, prefer "wait" unless a real answer is clearly required now.
- Answer the agent's question OR ask a new one — never both in the same turn.
- Keep each turn to one conversational act only.
- Keep spoken turns short: one sentence only, and usually under 14 words.
- Never answer future questions before the agent asks them.
- Never pack multiple future steps into one turn.
- Do not decide on booking, scheduling, rescheduling, confirmation, cancellation, or closing until the agent has actually asked about that specific step.
- On the first turn, only introduce yourself and state the reason for the call. Do not jump ahead to confirmations, decisions, or closing.
- Do not restate the whole scenario. If the agent misunderstood, correct only the mistaken fact and then stop.
- If you ask for something, ask for only one thing in that turn.
- Do not stack thanks + correction + request in the same turn.
- Avoid stacked mini-phrases like "Hi. Yes." or "Perfect. Thank you. I appreciate it." in a single turn.
- If the agent asks you to repeat or clarify, do so naturally.
- Do not volunteer major new facts or details unless the agent asked for them or they are necessary to answer the agent's latest turn.
- If the agent is still checking, looking something up, or continuing their thought, do not add extra details just because you know them.
- If the agent is only narrating that they are checking, taking a moment, looking something up, or otherwise continuing the same thought, prefer "wait".
- Do not reassure or encourage filler/process narration with replies like "okay", "sure", "take your time", or "that's fine" unless the agent explicitly asked for confirmation.
- Use "wait" sparingly. Keep it only when the agent is clearly still mid-task and more agent speech is genuinely expected.
- If the agent gives a closing statement or farewell and there is no real open question left, use "closing".
- Use "closing" when the caller's goal is complete and the caller is wrapping up naturally.
- Use "end_now" only when the caller should hang up without saying another line.
- When the agent says goodbye, confirms a later callback, or the conversation reaches a natural end, prefer "closing" with a brief, natural farewell instead of silence.`;

const INTERRUPT_SYSTEM_PROMPT = `You are a simulated phone caller. Your persona and goals are defined in the user's first message.

Rules:
- Return JSON only.
- Use one of these shapes:
  {"mode":"listen"}
  {"mode":"interrupt","text":"what you'd actually say to cut the agent off"}
- The text field must contain ONLY the exact spoken interruption — no stage directions, no quotes, no labels.
- Stay in character. Be natural and conversational.
- Prefer "listen" unless interrupting is actually natural for this caller and this moment.
- If you interrupt, keep it short and conversational.
- Never return the normal turn-taking shapes like "continue", "wait", "closing", or "end_now".`;

// ---------------------------------------------------------------------------
// Persona trait → behavioral instruction mapping
// ---------------------------------------------------------------------------

const PERSONA_TRAIT_MAP: Record<string, Record<string, string>> = {
  pace: {
    slow: "Speak slowly. Take your time with responses. Use longer pauses between thoughts. Sometimes trail off or start over.",
    normal: "",
    fast: "Speak quickly. Give short, rapid responses. Don't linger on any topic.",
  },
  clarity: {
    clear: "",
    vague: "Be vague in your descriptions. Use imprecise language like 'that thing' or 'you know, the stuff'. Don't volunteer specific details unless pushed.",
    rambling: "Ramble and go off on tangents. Tell unnecessary backstory. Circle back to your main point eventually but take detours.",
  },
  cooperation: {
    cooperative: "",
    reluctant: "Be reluctant to provide information. Make the agent work for every detail. Sigh, hesitate, and give partial answers.",
    hostile: "Be confrontational. Challenge the agent's competence. Express irritation and demand better service.",
  },
  emotion: {
    neutral: "",
    cheerful: "Be upbeat, friendly, and positive. Use warm language and express gratitude.",
    confused: "Be confused about the process. Ask clarifying questions. Misunderstand things occasionally and need them re-explained.",
    frustrated: "Express frustration about the situation. Be impatient. If the agent doesn't help quickly, escalate your displeasure.",
    skeptical: "Be skeptical of what the agent says. Question claims and ask for proof or details. Don't take things at face value.",
    rushed: "Be in a hurry. Mention you don't have much time. Push for quick resolution. Cut short long explanations.",
  },
  interruption_style: {
    low: "Sometimes interrupt the agent mid-sentence with follow-up questions or corrections when they're being verbose.",
    high: "Frequently cut off the agent. Start talking before they finish. Be impatient with long explanations.",
  },
  memory: {
    reliable: "",
    unreliable: "Have unreliable memory. Forget details you mentioned earlier. Contradict yourself occasionally. Need things repeated.",
  },
  intent_clarity: {
    clear: "",
    indirect: "Don't state your goal directly. Hint at what you need. Make the agent figure out your actual intent through conversation.",
    vague: "Be very vague about what you want. Say things like 'I need help with something' without specifying what. Force the agent to ask clarifying questions.",
  },
  confirmation_style: {
    explicit: "",
    vague: "Give vague confirmations. Say 'I guess so', 'sure, whatever', or 'if you say so' instead of clear yes/no answers.",
  },
};

function compilePersona(persona: CallerPersona): string {
  const instructions: string[] = [];

  for (const [trait, value] of Object.entries(persona)) {
    if (value === undefined || value === null) continue;

    if (trait === "disfluencies") {
      if (value === true) {
        instructions.push(
          "Include natural speech disfluencies — 'um', 'uh', 'like', 'you know'. Start some sentences over. Don't overdo it, keep it natural."
        );
      }
      continue;
    }

    const traitMap = PERSONA_TRAIT_MAP[trait];
    if (traitMap) {
      const instruction = traitMap[String(value)];
      if (instruction) {
        instructions.push(instruction);
      }
    }
  }

  if (instructions.length === 0) return "";

  return (
    "\n\nBehavioral modifiers (apply these consistently across ALL turns, but never override the JSON format, turn-taking, interruption, or brevity rules above):\n" +
    instructions.map((i) => `- ${i}`).join("\n")
  );
}

function compileLanguage(language: string): string {
  const name = LANGUAGE_NAMES[language] ?? language;
  return `\n\nLANGUAGE: You must speak entirely in ${name}. Every utterance must be in ${name}. Do not use English.`;
}

// ---------------------------------------------------------------------------
// CallerLLM
// ---------------------------------------------------------------------------

export class CallerLLM {
  private client: Anthropic;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private callerPrompt: string;
  private systemPrompt: string;
  private interruptSystemPrompt: string;

  constructor(callerPrompt: string, persona?: CallerPersona, language?: string) {
    this.client = new Anthropic();
    this.callerPrompt = callerPrompt;
    this.systemPrompt =
      SYSTEM_PROMPT +
      (persona ? compilePersona(persona) : "") +
      (language && language !== "en" ? compileLanguage(language) : "");
    this.interruptSystemPrompt =
      INTERRUPT_SYSTEM_PROMPT +
      (persona ? compilePersona(persona) : "") +
      (language && language !== "en" ? compileLanguage(language) : "");
  }

  /**
   * Generate the caller's next utterance based on the conversation so far.
   * Returns a structured decision about the caller's next action.
   */
  async nextUtterance(
    agentResponse: string | null,
    transcript: ConversationTurn[]
  ): Promise<CallerDecision | null> {
    const decision = await this.previewNextUtterance(agentResponse, transcript);
    if (!decision) return null;

    this.commitDecision(agentResponse, decision);
    return decision;
  }

  async previewNextUtterance(
    agentResponse: string | null,
    transcript: ConversationTurn[]
  ): Promise<CallerDecision | null> {
    const prompt = this.buildNextPrompt(agentResponse);
    const messages = prompt
      ? [...this.history, { role: "user" as const, content: prompt }]
      : [...this.history];

    return this.generateCallerDecision(messages);
  }

  commitDecision(agentResponse: string | null, decision: CallerDecision): void {
    const prompt = this.buildNextPrompt(agentResponse);
    if (prompt) {
      this.history.push({ role: "user", content: prompt });
    }
    if (decision.mode === "wait") {
      this.history.push({
        role: "assistant",
        content: "[You stayed silent and kept listening.]",
      });
      return;
    }
    if (decision.mode !== "end_now") {
      this.history.push({ role: "assistant", content: decision.text });
    }
  }

  /**
 * LLM-driven interrupt decision. Given partial agent speech, the CallerLLM
 * decides whether to interrupt based on persona and conversation context.
 *
 * Returns a structured interrupt decision. The LLM's decision is contextual —
 * an impatient caller interrupts verbose explanations, a cooperative caller
 * lets the agent finish important details like booking confirmations.
 */
  async decideInterrupt(
    partialAgentText: string,
    transcript: ConversationTurn[]
  ): Promise<InterruptDecision> {
    // Use a separate call (not appended to history) so a listen decision
    // doesn't pollute the conversation history
    const decisionMessages = [
      ...this.history,
      {
        role: "user" as const,
        content: `[The agent is mid-sentence. They are saying: "${partialAgentText}"]\n\nBased on your persona, decide whether to interrupt right now or keep listening.\nReturn JSON only, using one of these shapes:\n{"mode":"listen"}\n{"mode":"interrupt","text":"what you'd actually say to cut them off"}\n\nIf you interrupt, the text must be ONLY the spoken interruption.`,
      },
    ];

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: this.interruptSystemPrompt,
      messages: decisionMessages,
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    const decision = parseInterruptDecision(text);
    if (decision.mode === "listen") return decision;

    // LLM decided to interrupt — commit to conversation history
    this.history.push({
      role: "user",
      content: `[You interrupted the agent mid-sentence. They were saying: "${partialAgentText}"]`,
    });
    this.history.push({ role: "assistant", content: decision.text });

    return decision;
  }

  private buildNextPrompt(agentResponse: string | null): string | null {
    const isFirstTurn = this.history.length === 0;
    if (isFirstTurn) {
      return agentResponse
        ? `Your persona and goal:\n${this.callerPrompt}\n\nThe agent just greeted you with: "${agentResponse}"\nRespond naturally.`
        : `Your persona and goal:\n${this.callerPrompt}\n\nYou are starting the phone call. Say your opening line.`;
    }
    if (agentResponse) {
      return agentResponse;
    }
    return null;
  }

  private async generateCallerDecision(
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<CallerDecision | null> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: this.systemPrompt,
      messages,
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    return parseCallerDecision(text);
  }
}

export type CallerDecision =
  | { mode: "continue"; text: string }
  | { mode: "wait" }
  | { mode: "closing"; text: string }
  | { mode: "end_now" };

export type InterruptDecision =
  | { mode: "listen" }
  | { mode: "interrupt"; text: string };

function parseCallerDecision(raw: string): CallerDecision | null {
  const text = raw.trim();
  if (!text) return null;

  if (text === "[END]") {
    return { mode: "end_now" };
  }
  if (text === "[WAIT]" || text === "[LISTEN]") {
    return { mode: "wait" };
  }
  if (text.includes("[END]")) {
    const spoken = text.replace(/\[END\]/g, "").trim();
    return spoken
      ? { mode: "closing", text: spoken }
      : { mode: "end_now" };
  }

  const parsed = parseCallerDecisionJson(text);
  if (parsed) return parsed;

  return { mode: "continue", text };
}

function parseCallerDecisionJson(text: string): CallerDecision | null {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const mode = parsed.mode;
    const spoken = typeof parsed.text === "string" ? parsed.text.trim() : "";

    if (mode === "end_now") {
      return { mode: "end_now" };
    }
    if (mode === "wait") {
      return { mode: "wait" };
    }
    if ((mode === "continue" || mode === "closing") && spoken) {
      return { mode, text: spoken };
    }
  } catch {
    return null;
  }

  return null;
}

function parseInterruptDecision(raw: string): InterruptDecision {
  const text = raw.trim();
  if (!text) return { mode: "listen" };

  if (text === "[LISTEN]" || text.includes("[LISTEN]")) {
    return { mode: "listen" };
  }
  if (text === "[END]" || text.includes("[END]")) {
    return { mode: "listen" };
  }

  const candidate = extractJsonObject(text);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const mode = parsed.mode;
      const spoken = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (mode === "listen") {
        return { mode: "listen" };
      }
      if (mode === "interrupt" && spoken) {
        return { mode: "interrupt", text: spoken };
      }
    } catch {
      // Fall back to plain text below.
    }
  }

  return { mode: "interrupt", text };
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}
