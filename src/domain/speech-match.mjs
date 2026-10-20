/**
 * Compare what a model actually said with the line it was asked to say.
 *
 * Russian generated speech drifts in ways a plain string comparison cannot
 * judge: word forms shift, punctuation disappears, ё collapses into е. The
 * comparison is therefore word-level and tolerant of formatting, while still
 * separating "said the line" from "said something else".
 */

const PUNCTUATION = /[.,!?;:«»"'`()\[\]{}…—–\-\/\\]+/gu;

export const SPEECH_STATUSES = Object.freeze(["ok", "partial", "unusable", "missing"]);

/** Default thresholds; tuned to be strict enough that a wrong claim cannot pass as "ok". */
export const DEFAULT_SPEECH_THRESHOLDS = Object.freeze({ ok: 0.8, partial: 0.5 });

export function normalizeSpokenText(value) {
  if (typeof value !== "string") return [];
  return value
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(PUNCTUATION, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/** Word-level Levenshtein distance: insertions, deletions and substitutions of whole words. */
function wordDistance(expected, actual) {
  if (expected.length === 0) return actual.length;
  if (actual.length === 0) return expected.length;
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 1; i <= expected.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= actual.length; j += 1) {
      const substitution = previous[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }
  return previous[actual.length];
}

/**
 * Decide whether native audio can be accepted, or whether narration has to be
 * replaced. This is the check the Komend TTS gate depends on: the skill only
 * permits synthesis once native speech is missing or unusable.
 */
export function compareSpeech(expectedText, transcript, thresholds = DEFAULT_SPEECH_THRESHOLDS) {
  const expected = normalizeSpokenText(expectedText);
  const actual = normalizeSpokenText(transcript);

  if (expected.length === 0) {
    throw new TypeError("expected speech text is required to judge a transcript");
  }
  if (actual.length === 0) {
    return {
      status: "missing",
      similarity: 0,
      expected_words: expected.length,
      transcribed_words: 0,
      note: "no speech was transcribed",
    };
  }

  const distance = wordDistance(expected, actual);
  const similarity =
    Math.round((1 - distance / Math.max(expected.length, actual.length)) * 1e4) / 1e4;
  const status = similarity >= thresholds.ok ? "ok" : similarity >= thresholds.partial ? "partial" : "unusable";

  return {
    status,
    similarity,
    expected_words: expected.length,
    transcribed_words: actual.length,
    word_distance: distance,
    ...(status === "ok"
      ? {}
      : {
          note:
            status === "partial"
              ? "the line is recognisable but drifted; listen before accepting"
              : "the transcript does not match the requested line",
        }),
  };
}

/**
 * Map a comparison onto the native-audio status the TTS gate expects.
 * Anything short of a clean match is treated as unusable, so a doubtful take
 * cannot quietly authorize a second voice.
 */
export function nativeAudioStatusFrom(comparison) {
  if (comparison.status === "ok") return "usable";
  if (comparison.status === "missing") return "missing";
  return "unusable";
}
