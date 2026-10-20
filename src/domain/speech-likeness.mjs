// Thresholds are empirical, tuned on seven real takes from this repository.
// They are not a model and not a specification; they mark the point where a
// human should listen, not where a decision gets made.
const ACTIVE_ABOVE_FLOOR_DB = 12;
const BAND_DOMINANCE_DB = -6;
const MIN_VOICED_WINDOWS = 6;
const MIN_VOICED_SECONDS = 0.5;
const MIN_VOICED_SEGMENTS = 2;
const SPEECH_MODULATION_HZ = [1.5, 10];
const ABSOLUTE_FLOOR_DB = -45;

function percentile(values, ratio) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NEGATIVE_INFINITY;
  return finite[Math.min(finite.length - 1, Math.floor(finite.length * ratio))];
}

/**
 * Decide whether a track carries a speech-like signal.
 *
 * This is not recognition and not a VAD in the usual sense. It asks two
 * questions a couple of ffmpeg passes can answer: does the energy sit in the
 * 300-3400 Hz band, and does it fluctuate at a syllable-like rate. Measured on
 * this repository's takes, the band ratio alone puts an electrical whine inside
 * the speech range, which is why modulation is required too — and why the
 * verdict is advisory.
 */
export function scoreSpeechLikeness({ fullDb, speechDb, windowSeconds }) {
  if (!Array.isArray(fullDb) || !Array.isArray(speechDb) || fullDb.length === 0) {
    throw new TypeError("fullDb and speechDb must be non-empty arrays of dBFS values");
  }
  const count = Math.min(fullDb.length, speechDb.length);
  const notes = [];
  const noiseFloor = Math.min(percentile(fullDb.slice(0, count), 0.1), ABSOLUTE_FLOOR_DB);

  const voiced = [];
  for (let index = 0; index < count; index += 1) {
    const active = Number.isFinite(fullDb[index]) && fullDb[index] > noiseFloor + ACTIVE_ABOVE_FLOOR_DB;
    const dominant = Number.isFinite(speechDb[index]) && speechDb[index] - fullDb[index] > BAND_DOMINANCE_DB;
    voiced.push(active && dominant);
  }

  const segments = [];
  let start = null;
  for (let index = 0; index <= count; index += 1) {
    if (voiced[index]) {
      if (start === null) start = index;
      continue;
    }
    if (start === null) continue;
    const length = index - start;
    if (length >= MIN_VOICED_WINDOWS) {
      // Modulation is measured against the segment's own mean. A window average
      // that reaches into the surrounding silence would flatten the syllables
      // it is supposed to count.
      const values = speechDb.slice(start, index).filter((value) => Number.isFinite(value));
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      let crossings = 0;
      for (let position = start + 1; position < index; position += 1) {
        const before = speechDb[position - 1] - mean;
        const after = speechDb[position] - mean;
        if (Number.isFinite(before) && Number.isFinite(after) && before * after < 0) crossings += 1;
      }
      const durationSeconds = length * windowSeconds;
      segments.push({
        start_seconds: Math.round(start * windowSeconds * 1e3) / 1e3,
        end_seconds: Math.round(index * windowSeconds * 1e3) / 1e3,
        duration_seconds: Math.round(durationSeconds * 1e3) / 1e3,
        // Two zero crossings make one cycle of the envelope.
        modulation_hz: Math.round((crossings / 2 / durationSeconds) * 10) / 10,
      });
    }
    start = null;
  }

  const voicedSeconds = segments.reduce((sum, segment) => sum + segment.duration_seconds, 0);
  const plausible = segments.filter(
    (segment) =>
      segment.modulation_hz >= SPEECH_MODULATION_HZ[0] && segment.modulation_hz <= SPEECH_MODULATION_HZ[1],
  );

  // Speech alternates: syllables and pauses produce several voiced stretches,
  // while a growl, a whine or a metal hit produces one. On this repository's
  // takes that single distinction separated all three spoken clips from all four
  // unspoken ones, where the band ratio alone did not.
  let verdict = "speech_unlikely";
  if (voicedSeconds >= MIN_VOICED_SECONDS && plausible.length >= MIN_VOICED_SEGMENTS) {
    verdict = "speech_likely";
  } else if (voicedSeconds >= MIN_VOICED_SECONDS && plausible.length > 0) {
    verdict = "inconclusive";
    notes.push(
      "Один непрерывный речеподобный интервал без чередования: так звучат рык, звон и гул, но так же может звучать короткая реплика",
    );
  } else if (voicedSeconds >= MIN_VOICED_SECONDS) {
    verdict = "inconclusive";
    notes.push(
      "Энергия сидит в речевой полосе, но огибающая не колеблется как слоги: похоже на тон, рык или гул",
    );
  }
  if (noiseFloor === Number.NEGATIVE_INFINITY) notes.push("Дорожка почти пустая: статистики мало");

  const dominance = [];
  for (let index = 0; index < count; index += 1) {
    if (Number.isFinite(speechDb[index]) && Number.isFinite(fullDb[index])) {
      dominance.push(speechDb[index] - fullDb[index]);
    }
  }

  return {
    window_seconds: windowSeconds,
    window_count: count,
    noise_floor_db: Number.isFinite(noiseFloor) ? Math.round(noiseFloor * 10) / 10 : null,
    active_ratio: Math.round((voiced.filter(Boolean).length / count) * 1e3) / 1e3,
    band_dominance_db_median: dominance.length
      ? Math.round(percentile(dominance, 0.5) * 10) / 10
      : null,
    voiced_segments: segments,
    voiced_seconds_total: Math.round(voicedSeconds * 1e3) / 1e3,
    verdict,
    // Never a gate: false positives on growls, vocals and crowd noise are
    // expected, and whispers are missed.
    confidence: "low",
    notes,
  };
}
