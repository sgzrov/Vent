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
const MAX_TOKENS = 1024;

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

1. Say ONE or TWO short sentences per turn. Keep it under 25 words — be natural, not robotic.
2. Only respond to what the agent ALREADY said. Never anticipate future responses.
3. First turn: greet AND state why you are calling, like a real person would. Example: "Hi, my name is Sarah. I'm calling to check on my recent order."
4. Do not thank the agent for information they have not given you yet.
5. Do not confirm, schedule, cancel, or close until the agent explicitly offers or asks.
6. Do not pack your entire goal into one message. Let the conversation unfold naturally.

## When to use each mode

- "continue": You need to say something — answer a question, introduce yourself, ask something.
- "wait": The agent is still talking, checking, or processing. No response needed from you yet.
- "closing": The agent resolved your request and the conversation is wrapping up. Say a brief goodbye.
- "end_now": Hang up immediately without speaking.

## Handling messy agent speech

The agent's turn may have stutters, filler, repeats, or fragmented sentences (normal for voice calls). Ignore the noise and respond to the clearest intended meaning. If the agent seems mid-thought, use "wait".`;

const INTERRUPT_PLAN_SYSTEM_PROMPT = `You are a simulated phone caller. Your persona and goals are defined in the user's first message.

Rules:
- Return JSON only.
- Use one of these shapes:
  {"mode":"listen"}
  {"mode":"interrupt","text":"what you'd actually say to cut the agent off"}
- The text field must contain ONLY the exact spoken interruption — no stage directions, no quotes, no labels.
- Stay in character. Be natural and conversational.
- You are deciding BEFORE the agent starts responding.
- Prefer "listen" unless this caller would plausibly cut off a long, verbose, or off-target next answer.
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
  private interruptPlanSystemPrompt: string;

  constructor(callerPrompt: string, persona?: CallerPersona, language?: string) {
    this.client = new Anthropic();
    this.callerPrompt = callerPrompt;
    this.systemPrompt =
      SYSTEM_PROMPT +
      (persona ? compilePersona(persona) : "") +
      (language && language !== "en" ? compileLanguage(language) : "");
    this.interruptPlanSystemPrompt =
      INTERRUPT_PLAN_SYSTEM_PROMPT +
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

  /**
   * Stream the caller's next utterance, yielding sentence-sized chunks
   * as they are detected in the LLM token stream.
   * Returns the full CallerDecision after the stream completes.
   * Automatically commits the decision to history.
   */
  async streamNextUtterance(
    agentResponse: string | null,
    transcript: ConversationTurn[],
    onSentence: (sentence: string) => void,
  ): Promise<CallerDecision | null> {
    const prompt = this.buildNextPrompt(agentResponse);
    const messages = [...this.history, { role: "user" as const, content: prompt }];

    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
      system: this.systemPrompt,
      messages,
    });

    let fullText = "";
    let extractedSoFar = 0; // chars of extracted text already yielded

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;

        // Try to extract the "text" field progressively from the JSON
        const extracted = extractPartialTextField(fullText);
        if (extracted && extracted.length > extractedSoFar) {
          const newText = extracted.slice(extractedSoFar);
          // Find sentence boundaries in the new text
          const boundary = findLastSentenceBoundary(newText);
          if (boundary > 0) {
            const sentence = newText.slice(0, boundary).trim();
            if (sentence) {
              onSentence(sentence);
              extractedSoFar += boundary;
            }
          }
        }
      }
    }

    // Flush any remaining text
    const extracted = extractPartialTextField(fullText);
    if (extracted && extracted.length > extractedSoFar) {
      const remaining = extracted.slice(extractedSoFar).trim();
      if (remaining) {
        onSentence(remaining);
      }
    }

    // Parse the complete response
    const finalMessage = await stream.finalMessage();
    const responseText = finalMessage.content[0]?.type === "text"
      ? finalMessage.content[0].text.trim()
      : "";

    const lastUserMsg = messages[messages.length - 1]?.content ?? "(none)";
    const preview = typeof lastUserMsg === "string" ? lastUserMsg.slice(0, 120) : "(structured)";
    console.log(`[caller-llm] prompt="${preview}" raw_response="${responseText.slice(0, 200)}" history_len=${this.history.length}`);

    const decision = parseCallerDecision(responseText);
    if (decision && "text" in decision) {
      console.log(`[caller-llm] parsed mode=${decision.mode} text="${decision.text}"`);
    } else {
      console.log(`[caller-llm] parsed mode=${decision?.mode ?? "null"}`);
    }

    if (decision) {
      this.commitDecision(agentResponse, decision);
    }
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
   * Pre-plan whether the caller would cut off the upcoming agent turn if it
   * gets too long or goes in the wrong direction. This happens before the
   * agent starts speaking, so execution stays in the realtime audio path.
   */
  async planInterrupt(
    currentCallerText: string,
  ): Promise<InterruptDecision> {
    const decisionMessages = [
      ...this.history,
      {
        role: "user" as const,
        content:
          `[Planning only, before the agent's next response. You just said: "${currentCallerText}"]\n\n` +
          `If the agent's next reply becomes long, repetitive, or goes in the wrong direction, ` +
          `would you naturally cut them off on this turn?\n` +
          `Return JSON only using one of these shapes:\n` +
          `{"mode":"listen"}\n` +
          `{"mode":"interrupt","text":"what you'd actually say to cut them off"}\n\n` +
          `If you interrupt, the text must be ONLY the spoken interruption.`,
      },
    ];

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: this.interruptPlanSystemPrompt,
      messages: decisionMessages,
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    const decision = parseInterruptDecision(text);
    return decision;
  }

  /**
   * Classify agent speech as filler (transitional/holding before a tool result)
   * or complete (substantive response). Used to detect when an agent says
   * "Let me check that" before executing a tool call — so Vent can wait
   * for the actual answer instead of advancing to the next caller turn.
   */
  async classifyAgentSpeech(agentText: string): Promise<FillerClassification> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 16,
      temperature: 0,
      system: `Classify the agent's speech as either "filler" or "complete".

filler = A very short (under 10 words) transitional phrase where the agent says they will do something but has NOT done it yet, and says NOTHING else. The ENTIRE utterance must be a pure holding statement. Examples: "Let me check that for you", "One moment please", "Sure, let me look that up".

complete = everything else, including:
- Any response that reports a result or outcome (e.g., "I wasn't able to find...", "I don't see...")
- Any response with two or more sentences
- Any response that asks the caller a question
- Any response containing information, instructions, or findings
- Greetings and farewells
- Any response that appears truncated or cut off

Default to "complete". Only return "filler" for very short, purely transitional phrases with zero substantive content.

Return exactly one word: filler or complete`,
      messages: [{ role: "user", content: agentText }],
    });

    const raw = response.content[0]?.type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";

    const result: FillerClassification = raw === "filler" ? "filler" : "complete";
    console.log(`[filler-detect] text="${agentText.slice(0, 80)}" classification=${result}`);
    return result;
  }

  private buildNextPrompt(agentResponse: string | null): string {
    const isFirstTurn = this.history.length === 0;
    if (isFirstTurn) {
      return agentResponse
        ? `Your persona and goal:\n${this.callerPrompt}\n\nThe agent just greeted you with: "${agentResponse}"\nRespond with a greeting AND state why you are calling. Do both in one turn.`
        : `Your persona and goal:\n${this.callerPrompt}\n\nYou are starting the phone call. Greet AND state why you are calling.`;
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

export type FillerClassification = "filler" | "complete";

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

  // Unparseable LLM output — safe fallback is to listen, not speak raw text
  return { mode: "listen" };
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

/**
 * Extract the "text" field value progressively from partially streamed JSON.
 * Handles: {"mode":"continue","text":"sentence here."} and variations.
 */
function extractPartialTextField(partial: string): string | null {
  // Find "text" key followed by colon and opening quote
  const match = partial.match(/"text"\s*:\s*"/);
  if (!match || match.index === undefined) return null;

  const textStart = match.index + match[0].length;
  let result = "";
  let escaped = false;
  for (let i = textStart; i < partial.length; i++) {
    if (escaped) {
      if (partial[i] === "n") result += "\n";
      else if (partial[i] === "t") result += "\t";
      else result += partial[i];
      escaped = false;
      continue;
    }
    if (partial[i] === "\\") { escaped = true; continue; }
    if (partial[i] === '"') break;
    result += partial[i];
  }
  return result || null;
}

/**
 * Find the position just after the last sentence-ending punctuation.
 * Returns 0 if no boundary found.
 */
function findLastSentenceBoundary(text: string): number {
  const matches = [...text.matchAll(/[.!?]+\s/g)];
  if (matches.length === 0) return 0;
  const last = matches[matches.length - 1]!;
  return last.index! + last[0].length;
}
