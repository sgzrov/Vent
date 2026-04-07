/**
 * Transcript-level metrics — pure functions, no external deps.
 */

import type { ConversationTurn, HallucinationEvent, TranscriptMetrics } from "@vent/shared";

let _normalizer: { normalize(s: string): string } | null = null;
async function getWerNormalizer() {
  if (!_normalizer) {
    const { EnglishTextNormalizer } = await import("@shelf/text-normalizer");
    _normalizer = new EnglishTextNormalizer();
  }
  return _normalizer;
}

const FILLER_WORDS = new Set([
  "um", "uh", "erm", "er", "ah", "like", "hmm", "hm",
  "you know", "i mean", "sort of", "kind of",
]);
const HALLUCINATION_MIN_RUN_LENGTH = 5;
const LANGUAGES_WITHOUT_RELIABLE_WORD_BOUNDARIES = new Set([
  "zh",
  "ja",
  "th",
  "lo",
  "my",
  "km",
]);

type AlignmentOpType = "equal" | "substitution" | "insertion" | "deletion";

interface AlignmentOp {
  type: AlignmentOpType;
  reference?: string;
  hypothesis?: string;
}

/**
 * Word Error Rate via word-level Levenshtein distance.
 * Compares our STT transcript (reference) to the platform's STT transcript
 * (hypothesis) of the same caller speech. Measures how accurately the
 * agent's platform heard the caller.
 */
export function computeWER(reference: string, hypothesis: string): number {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { distance } = computeWerAlignment(ref, hyp);
  return distance / ref.length;
}

export function computeCER(reference: string, hypothesis: string): number {
  const ref = tokenizeCharacters(reference);
  const hyp = tokenizeCharacters(hypothesis);

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { distance } = computeWerAlignment(ref, hyp);
  return distance / ref.length;
}

export function extractHallucinationEvents(
  reference: string,
  hypothesis: string,
  minRunLength = HALLUCINATION_MIN_RUN_LENGTH,
): HallucinationEvent[] {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0 || hyp.length === 0) return [];

  const { alignment } = computeWerAlignment(ref, hyp);
  return hallucinationEventsFromAlignment(alignment, minRunLength);
}

/**
 * Repetition score: bigram overlap across agent turns.
 * High score = agent repeating itself.
 */
export function computeRepetitionScore(agentTexts: string[]): number {
  if (agentTexts.length < 2) return 0;

  const turnBigrams = agentTexts.map((text) => {
    const words = tokenize(text);
    const bigrams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  });

  let totalOverlap = 0;
  let totalComparisons = 0;

  for (let i = 0; i < turnBigrams.length; i++) {
    for (let j = i + 1; j < turnBigrams.length; j++) {
      const a = turnBigrams[i]!;
      const b = turnBigrams[j]!;
      if (a.size === 0 || b.size === 0) continue;
      let overlap = 0;
      for (const bg of a) {
        if (b.has(bg)) overlap++;
      }
      totalOverlap += overlap / Math.max(a.size, b.size);
      totalComparisons++;
    }
  }

  return totalComparisons === 0 ? 0 : totalOverlap / totalComparisons;
}

/**
 * Count filler words per 100 words in agent responses.
 */
export function computeFillerWordRate(agentTexts: string[]): number {
  const allText = agentTexts.join(" ").toLowerCase();
  const words = tokenize(allText);
  if (words.length === 0) return 0;

  let fillerCount = 0;

  // Single-word fillers
  for (const word of words) {
    if (FILLER_WORDS.has(word)) fillerCount++;
  }

  // Multi-word fillers
  for (const filler of FILLER_WORDS) {
    if (!filler.includes(" ")) continue;
    const pattern = filler.split(" ");
    for (let i = 0; i <= words.length - pattern.length; i++) {
      if (pattern.every((p, j) => words[i + j] === p)) fillerCount++;
    }
  }

  return (fillerCount / words.length) * 100;
}

/**
 * Vocabulary diversity: unique words / total words in agent responses.
 */
export function computeVocabularyDiversity(agentTexts: string[]): number {
  const words = tokenize(agentTexts.join(" "));
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

/**
 * Words per minute based on audio duration.
 */
export function computeWordsPerMinute(
  agentTexts: string[],
  totalAudioDurationMs: number,
): number {
  if (totalAudioDurationMs <= 0) return 0;
  const totalWords = agentTexts.reduce((sum, t) => sum + tokenize(t).length, 0);
  return (totalWords / totalAudioDurationMs) * 60_000;
}

/**
 * Count how many times the agent asks the caller to repeat or rephrase.
 */
export function computeRepromptCount(agentTexts: string[]): number {
  const patterns = [
    /could you (please )?(repeat|say that again|rephrase)/i,
    /i didn'?t (quite )?(catch|understand|get) that/i,
    /can you (please )?(repeat|say that again)/i,
    /sorry,? (what|could you)/i,
    /one more time/i,
    /pardon/i,
  ];

  let count = 0;
  for (const text of agentTexts) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        count++;
        break;
      }
    }
  }
  return count;
}

function computeRepromptRate(repromptCount: number, agentTurnCount: number): number {
  if (agentTurnCount <= 0) return 0;
  return Math.round((repromptCount / agentTurnCount) * 1000) / 1000;
}

export async function computeTranscriptMetrics(
  turns: ConversationTurn[],
  fullPlatformCallerText?: string,
  language?: string,
): Promise<TranscriptMetrics> {
  const agentTurns = turns.filter((t) => t.role === "agent");
  const agentTexts = agentTurns.map((t) => t.text);
  const totalAgentAudioMs = agentTurns.reduce((sum, t) => sum + (t.audio_duration_ms ?? 0), 0);
  const repromptCount = computeRepromptCount(agentTexts);

  // WER: compare our caller speech text vs platform's STT of the same speech.
  // Use fullPlatformCallerText (all user entries concatenated, no turn alignment)
  // when available — avoids data loss from turn count mismatches.
  const callerTexts = turns
    .filter((t) => t.role === "caller" && t.text)
    .map((t) => t.text);
  const refStr = callerTexts.join(" ");

  // Prefer full platform transcript (no turn alignment issues) over per-turn
  const hypStr = fullPlatformCallerText?.trim()
    || turns
        .filter((t) => t.role === "caller" && t.platform_transcript)
        .map((t) => t.platform_transcript!)
        .join(" ");

  // Whisper-style normalization: expand contractions, normalize numbers, lowercase, strip punctuation/fillers
  let wer: number | undefined;
  let cer: number | undefined;
  let hallucinationEvents: HallucinationEvent[] | undefined;
  if (refStr.length > 0 && hypStr.length > 0) {
    const normRef = await normalizeForWer(refStr, language);
    const normHyp = await normalizeForWer(hypStr, language);

    if (supportsWordErrorRate(language)) {
      wer = normRef.length > 0 && normHyp.length > 0
        ? computeWERWithLanguage(normRef, normHyp, language)
        : undefined;
      hallucinationEvents = normRef.length > 0 && normHyp.length > 0
        ? extractHallucinationEventsWithLanguage(normRef, normHyp, language)
        : undefined;
    } else {
      cer = normRef.length > 0 && normHyp.length > 0
        ? computeCER(normRef, normHyp)
        : undefined;
    }
  }

  return {
    wer,
    cer,
    hallucination_events: hallucinationEvents?.length ? hallucinationEvents : undefined,
    repetition_score: computeRepetitionScore(agentTexts),
    reprompt_count: repromptCount,
    reprompt_rate: computeRepromptRate(repromptCount, agentTexts.length),
    filler_word_rate: computeFillerWordRate(agentTexts),
    words_per_minute: totalAgentAudioMs > 0 ? computeWordsPerMinute(agentTexts, totalAgentAudioMs) : undefined,
    vocabulary_diversity: computeVocabularyDiversity(agentTexts),
  };
}

const WORD_TO_DIGIT: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50",
  sixty: "60", seventy: "70", eighty: "80", ninety: "90",
};

/**
 * Normalize number words to digits so WER isn't inflated by
 * "five five five" vs "555" mismatches.
 *
 * Handles: single digits, teens, tens, tens+units compounds ("twenty one" → "21"),
 * "oh" → "0", "double X" → "X X".
 */
function normalizeNumbers(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();

    // "double five" → "5 5"
    if (w === "double" && i + 1 < words.length) {
      const next = words[i + 1]!.toLowerCase();
      const digit = WORD_TO_DIGIT[next];
      if (digit) {
        out.push(digit, digit);
        i++;
        continue;
      }
    }

    // "triple five" → "5 5 5"
    if (w === "triple" && i + 1 < words.length) {
      const next = words[i + 1]!.toLowerCase();
      const digit = WORD_TO_DIGIT[next];
      if (digit) {
        out.push(digit, digit, digit);
        i++;
        continue;
      }
    }

    const val = WORD_TO_DIGIT[w];
    if (val != null) {
      const numVal = Number(val);
      // Tens + units compound: "twenty one" → "21"
      if (numVal >= 20 && numVal % 10 === 0 && i + 1 < words.length) {
        const next = words[i + 1]!.toLowerCase();
        const unitVal = WORD_TO_DIGIT[next];
        if (unitVal != null && Number(unitVal) >= 1 && Number(unitVal) <= 9) {
          out.push(String(numVal + Number(unitVal)));
          i++;
          continue;
        }
      }
      out.push(val);
    } else {
      out.push(words[i]!);
    }
  }

  return out.join(" ");
}

function tokenize(text: string, language?: string): string[] {
  const normalized = basicNormalizeText(text, language);
  return normalized.length > 0
    ? normalized.split(/\s+/u).filter((w) => w.length > 0)
    : [];
}

function tokenizeCharacters(text: string): string[] {
  return Array.from(
    text
      .normalize("NFKC")
      .replace(/\s+/gu, ""),
  );
}

function basicNormalizeText(text: string, language?: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase(language)
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function normalizeForWer(text: string, language?: string): Promise<string> {
  if (isEnglishLanguage(language)) {
    const normalizer = await getWerNormalizer();
    return normalizeNumbers(normalizer.normalize(text));
  }
  return basicNormalizeText(text, language);
}

function computeWERWithLanguage(reference: string, hypothesis: string, language?: string): number {
  const ref = tokenize(reference, language);
  const hyp = tokenize(hypothesis, language);

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { distance } = computeWerAlignment(ref, hyp);
  return distance / ref.length;
}

function extractHallucinationEventsWithLanguage(
  reference: string,
  hypothesis: string,
  language?: string,
): HallucinationEvent[] {
  const ref = tokenize(reference, language);
  const hyp = tokenize(hypothesis, language);
  if (ref.length === 0 || hyp.length === 0) return [];

  const { alignment } = computeWerAlignment(ref, hyp);
  return hallucinationEventsFromAlignment(alignment, HALLUCINATION_MIN_RUN_LENGTH);
}

function isEnglishLanguage(language?: string): boolean {
  if (!language) return true;
  return language.toLowerCase().startsWith("en");
}

function supportsWordErrorRate(language?: string): boolean {
  if (!language) return true;
  const baseLanguage = language.toLowerCase().split(/[-_]/)[0] ?? language.toLowerCase();
  return !LANGUAGES_WITHOUT_RELIABLE_WORD_BOUNDARIES.has(baseLanguage);
}

function computeWerAlignment(reference: string[], hypothesis: string[]): { distance: number; alignment: AlignmentOp[] } {
  const dp: number[][] = Array.from({ length: reference.length + 1 }, () =>
    new Array(hypothesis.length + 1).fill(0),
  );

  for (let i = 0; i <= reference.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= hypothesis.length; j++) dp[0]![j] = j;

  for (let i = 1; i <= reference.length; i++) {
    for (let j = 1; j <= hypothesis.length; j++) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }

  const alignment: AlignmentOp[] = [];
  let i = reference.length;
  let j = hypothesis.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      if (dp[i]![j] === dp[i - 1]![j - 1]! + cost) {
        alignment.push({
          type: cost === 0 ? "equal" : "substitution",
          reference: reference[i - 1],
          hypothesis: hypothesis[j - 1],
        });
        i--;
        j--;
        continue;
      }
    }

    if (j > 0 && dp[i]![j] === dp[i]![j - 1]! + 1) {
      alignment.push({
        type: "insertion",
        hypothesis: hypothesis[j - 1],
      });
      j--;
      continue;
    }

    if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      alignment.push({
        type: "deletion",
        reference: reference[i - 1],
      });
      i--;
      continue;
    }

    throw new Error("WER alignment backtrace failed");
  }

  alignment.reverse();
  return { distance: dp[reference.length]![hypothesis.length]!, alignment };
}

function hallucinationEventsFromAlignment(
  alignment: AlignmentOp[],
  minRunLength: number,
): HallucinationEvent[] {
  const events: HallucinationEvent[] = [];
  let run: AlignmentOp[] = [];

  const flush = () => {
    if (run.length >= minRunLength) {
      events.push({
        error_count: run.length,
        reference_text: run.map((op) => op.reference).filter((value): value is string => !!value).join(" "),
        hypothesis_text: run.map((op) => op.hypothesis).filter((value): value is string => !!value).join(" "),
      });
    }
    run = [];
  };

  for (const op of alignment) {
    if (op.type === "insertion" || op.type === "substitution") {
      run.push(op);
      continue;
    }
    flush();
  }

  flush();
  return events;
}
