/**
 * Caller LLM — generates dynamic caller utterances from a persona prompt.
 *
 * Uses Anthropic Haiku for speed. Maintains conversation history
 * and returns [END] when the conversation should conclude naturally.
 *
 * Optional CallerPersona injects behavioral modifiers into the system prompt,
 * keeping persona traits (HOW the caller behaves) separate from the caller_prompt
 * (WHAT the caller wants).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ConversationTurn, CallerPersona } from "@voiceci/shared";
import { LANGUAGE_NAMES } from "@voiceci/voice";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 200;

const SYSTEM_PROMPT = `You are a simulated phone caller. Your persona and goals are defined in the user's first message.

Rules:
- Respond with ONLY your next spoken line — no stage directions, no quotes, no labels.
- Stay in character. Be natural and conversational.
- When the conversation has reached a natural conclusion or your goal is met, respond with exactly: [END]
- Keep responses concise (1-3 sentences max) — this is a phone call, not an essay.
- If the agent asks you to repeat or clarify, do so naturally.`;

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
    none: "",
    occasional: "Occasionally interrupt the agent mid-sentence with follow-up questions or corrections.",
    frequent: "Frequently cut off the agent. Start talking before they finish. Be impatient with long explanations.",
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
    "\n\nBehavioral modifiers (apply these consistently across ALL turns):\n" +
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

  constructor(callerPrompt: string, persona?: CallerPersona, language?: string) {
    this.client = new Anthropic();
    this.callerPrompt = callerPrompt;
    this.systemPrompt =
      SYSTEM_PROMPT +
      (persona ? compilePersona(persona) : "") +
      (language && language !== "en" ? compileLanguage(language) : "");
  }

  /**
   * Generate the caller's next utterance based on the conversation so far.
   * Returns null if the caller has decided to end the conversation.
   */
  async nextUtterance(
    agentResponse: string | null,
    transcript: ConversationTurn[]
  ): Promise<string | null> {
    // Build user message
    if (this.history.length === 0) {
      // First turn: include the persona prompt
      this.history.push({
        role: "user",
        content: `Your persona and goal:\n${this.callerPrompt}\n\nYou are starting the phone call. Say your opening line.`,
      });
    } else if (agentResponse) {
      // Subsequent turns: agent's response becomes the user message
      this.history.push({
        role: "user",
        content: agentResponse,
      });
    }

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: this.systemPrompt,
      messages: this.history,
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    // Add assistant response to history
    this.history.push({ role: "assistant", content: text });

    // Check for end signal
    if (text === "[END]" || text.includes("[END]")) {
      return null;
    }

    return text;
  }
}
