import assert from "node:assert/strict";
import test from "node:test";
import { scoreSpeechLikeness } from "../src/domain/speech-likeness.mjs";

/** A stretch of windows at a given level, optionally wobbling like syllables. */
function stretch({ count, fullDb, bandOffsetDb, wobbleDb = 0, period = 4 }) {
  const full = [];
  const band = [];
  for (let index = 0; index < count; index += 1) {
    const wobble = wobbleDb === 0 ? 0 : (index % period < period / 2 ? wobbleDb : -wobbleDb);
    full.push(fullDb);
    band.push(fullDb + bandOffsetDb + wobble);
  }
  return { full, band };
}

function track(parts) {
  const fullDb = [];
  const speechDb = [];
  for (const part of parts) {
    fullDb.push(...part.full);
    speechDb.push(...part.band);
  }
  return { fullDb, speechDb, windowSeconds: 0.05 };
}

const silence = (count) => stretch({ count, fullDb: -60, bandOffsetDb: -6 });

test("steady room tone is not speech", () => {
  const result = scoreSpeechLikeness(track([silence(20), stretch({ count: 60, fullDb: -50, bandOffsetDb: -10 })]));
  assert.equal(result.verdict, "speech_unlikely");
  assert.equal(result.voiced_segments.length, 0);
});

test("alternating syllable-rate energy in the speech band reads as speech", () => {
  const result = scoreSpeechLikeness(
    track([
      silence(10),
      stretch({ count: 14, fullDb: -20, bandOffsetDb: -1, wobbleDb: 2, period: 4 }),
      silence(6),
      stretch({ count: 14, fullDb: -21, bandOffsetDb: -1, wobbleDb: 2, period: 4 }),
      silence(6),
      stretch({ count: 12, fullDb: -20, bandOffsetDb: -1, wobbleDb: 2, period: 4 }),
      silence(10),
    ]),
  );
  assert.equal(result.verdict, "speech_likely");
  assert.ok(result.voiced_segments.length >= 2);
  assert.equal(result.confidence, "low");
});

test("one continuous burst in the speech band is inconclusive, not a verdict", () => {
  // A growl or an electrical whine: the band is right, the alternation is not.
  const result = scoreSpeechLikeness(
    track([silence(10), stretch({ count: 40, fullDb: -20, bandOffsetDb: -1, wobbleDb: 2, period: 4 }), silence(10)]),
  );
  assert.equal(result.verdict, "inconclusive");
  assert.match(result.notes.join(" "), /без чередования/);
});

test("loud energy outside the speech band is not speech", () => {
  const result = scoreSpeechLikeness(
    track([silence(10), stretch({ count: 40, fullDb: -15, bandOffsetDb: -18, wobbleDb: 2 }), silence(10)]),
  );
  assert.equal(result.verdict, "speech_unlikely");
});

test("an empty track says so instead of guessing", () => {
  const result = scoreSpeechLikeness(track([silence(40)]));
  assert.equal(result.verdict, "speech_unlikely");
  assert.equal(result.voiced_seconds_total, 0);
});

test("the score always states its own weakness", () => {
  const result = scoreSpeechLikeness(track([silence(10), stretch({ count: 20, fullDb: -20, bandOffsetDb: -1, wobbleDb: 2, period: 4 })]));
  assert.equal(result.confidence, "low");
  assert.equal(typeof result.band_dominance_db_median, "number");
  assert.equal(result.window_seconds, 0.05);
});

test("mismatched inputs are refused rather than half-measured", () => {
  assert.throws(() => scoreSpeechLikeness({ fullDb: [], speechDb: [], windowSeconds: 0.05 }), /non-empty arrays/);
});
