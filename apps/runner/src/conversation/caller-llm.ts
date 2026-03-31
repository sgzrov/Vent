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
const MAX_TOKENS = 48;

const SYSTEM_PROMPT = `You are a simulated phone caller on a live voice call. You will be called once per turn to produce your SINGLE next spoken line.

## How this works

You do NOT control the whole conversation. You say ONE line, then the system sends it as audio to the agent, waits for the agent to respond, transcribes the agent's reply, and calls you again with that reply. This repeats turn by turn. You must NEVER skip ahead — you can only react to what the agent has actually said so far.

## Response format

Return exactly one JSON object. No other text.

Shapes:
  {"mode":"continue","text":"your one spoken line"}
  {"mode":"wait"}
  {"mode":"closing","text":"your brief goodbye"}
  {"mode":"end_now"}

## Turn-taking rules (most important)

1. Say ONE sentence per turn. Maximum 15 words. No exceptions.
2. Only respond to what the agent ALREADY said. Never anticipate future responses.
3. Never combine greeting + question + thanks in one turn. Pick one.
4. First turn: introduce yourself and state why you are calling. Nothing else.
5. Do not thank the agent for information they have not given you yet.
6. Do not confirm, schedule, cancel, or close until the agent explicitly offers or asks.
7. Do not pack your entire goal into one message. Let the conversation unfold naturally.

## When to use each mode

- "continue": You need to say something — answer a question, introduce yourself, ask something.
- "wait": The agent is still talking, checking, or processing. No response needed from you yet.
- "closing": The agent resolved your request and the conversation is wrapping up. Say a brief goodbye.
- "end_now": Hang up immediately without speaking.

## Handling messy agent speech

The agent's turn may have stutters, filler, repeats, or fragmented sentences (normal for voice calls). Ignore the noise and respond to the clearest intended meaning. If the agent seems mid-thought, use "wait".`;

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
    const messages = [...this.history, { role: "user" as const, content: prompt }];

    return this.generateCallerDecision(messages);
  }

  commitDecision(agentResponse: string | null, decision: CallerDecision): void {
    const prompt = this.buildNextPrompt(agentResponse);
    this.history.push({ role: "user", content: prompt });
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

  private buildNextPrompt(agentResponse: string | null): string {
    const isFirstTurn = this.history.length === 0;
    if (isFirstTurn) {
      return agentResponse
        ? `Your persona and goal:\n${this.callerPrompt}\n\nThe agent just greeted you with: "${agentResponse}"\nRespond naturally.`
        : `Your persona and goal:\n${this.callerPrompt}\n\nYou are starting the phone call. Say your opening line.`;
    }
    if (agentResponse) {
      return agentResponse;
    }
    return "[The agent has not spoken yet. Use \"wait\".]";
  }

  private async generateCallerDecision(
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<CallerDecision | null> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
      system: this.systemPrompt,
      messages,
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    const lastUserMsg = messages[messages.length - 1]?.content ?? "(none)";
    const preview = typeof lastUserMsg === "string" ? lastUserMsg.slice(0, 120) : "(structured)";
    console.log(`[caller-llm] prompt="${preview}" raw_response="${text.slice(0, 200)}" history_len=${this.history.length}`);

    const decision = parseCallerDecision(text);
    if (decision && "text" in decision) {
      console.log(`[caller-llm] parsed mode=${decision.mode} text="${decision.text}"`);
    } else {
      console.log(`[caller-llm] parsed mode=${decision?.mode ?? "null"}`);
    }
    return decision;
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

  return { mode: "continue", text: truncateToFirstSentence(text) };
}

/**
 * Truncate to the first sentence to prevent multi-sentence monologues.
 * Splits on sentence-ending punctuation followed by a space or end-of-string.
 */
function truncateToFirstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1] : text;
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
      return { mode, text: truncateToFirstSentence(spoken) };
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
