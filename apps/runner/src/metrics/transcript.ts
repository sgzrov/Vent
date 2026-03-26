/**
 * Transcript-level metrics — pure functions, no external deps.
 */

import type { ConversationTurn, TranscriptMetrics } from "@vent/shared";

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

  const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array(hyp.length + 1).fill(0),
  );

  for (let i = 0; i <= ref.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0]![j] = j;

  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,     // deletion
        dp[i]![j - 1]! + 1,     // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return Math.min(dp[ref.length]![hyp.length]! / ref.length, 1);
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

/**
 * Compute all transcript metrics from conversation turns.
 */
export async function computeTranscriptMetrics(turns: ConversationTurn[], fullPlatformCallerText?: string): Promise<TranscriptMetrics> {
  const agentTurns = turns.filter((t) => t.role === "agent");
  const agentTexts = agentTurns.map((t) => t.text);
  const totalAgentAudioMs = agentTurns.reduce((sum, t) => sum + (t.audio_duration_ms ?? 0), 0);

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
  if (refStr.length > 0 && hypStr.length > 0) {
    const normalizer = await getWerNormalizer();
    const normRef = normalizer.normalize(refStr);
    const normHyp = normalizer.normalize(hypStr);
    wer = normRef.length > 0 && normHyp.length > 0
      ? computeWER(normRef, normHyp)
      : undefined;
  }

  return {
    wer,
    repetition_score: computeRepetitionScore(agentTexts),
    reprompt_count: computeRepromptCount(agentTexts),
    filler_word_rate: computeFillerWordRate(agentTexts),
    words_per_minute: totalAgentAudioMs > 0 ? computeWordsPerMinute(agentTexts, totalAgentAudioMs) : undefined,
    vocabulary_diversity: computeVocabularyDiversity(agentTexts),
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
