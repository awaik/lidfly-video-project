import {
  assertNoUnknownKeys,
  assertObject,
  identifier,
  integerInRange,
  numberInRange,
  oneOf,
  optionalString,
  requiredString,
} from "../core/validation.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "project_id",
  "variant_id",
  "output",
  "segments",
  "audio",
  "notes",
]);
const OUTPUT_FIELDS = new Set(["width", "height", "frame_rate", "audio_sample_rate", "masters_root", "fit"]);
const SEGMENT_FIELDS = new Set([
  "id",
  "kind",
  "fit",
  "source",
  "sources",
  "frames",
  "in_seconds",
  "speed",
  "audio",
  "motion",
  "overlays",
  "review",
]);
const OVERLAY_FIELDS = new Set([
  "asset",
  "x",
  "y",
  "scale",
  "from_seconds",
  "to_seconds",
  "note",
  "subject_checked_at_seconds",
  "subject_clear",
]);
const SPEED_FIELDS = new Set(["factor", "interpolation"]);
export const RETIME_INTERPOLATIONS = Object.freeze(["none", "blend", "motion"]);
const MOTION_FIELDS = new Set(["type", "to_y", "amount"]);
const AUDIO_FIELDS = new Set(["music", "voiceover", "native", "speech", "ducking", "limit", "target_lufs"]);
const NATIVE_FIELDS = new Set(["role", "gain", "duck_level"]);
/** What a clip's own soundtrack is: dialogue to keep intelligible, or effects that sit under a voiceover. */
const NATIVE_ROLES = ["speech", "effects"];
const VOICEOVER_FIELDS = new Set(["cues", "rights", "provenance"]);
const CUE_FIELDS = new Set(["id", "source", "at_seconds", "duration_seconds"]);
const MUSIC_FIELDS = new Set(["source", "gain", "fade_out_from_seconds", "fade_out_seconds", "rights"]);
const SPEECH_FIELDS = new Set(["normalize_lufs", "gain"]);
const DUCKING_FIELDS = new Set(["level", "ramp_seconds"]);

export const SEGMENT_KINDS = Object.freeze(["clip", "still", "still_sequence"]);
export const MOTION_TYPES = Object.freeze(["none", "scroll", "zoom_in"]);
/**
 * What to do with a source whose shape is not the output's.
 *
 * There is deliberately no default: assembly refuses a mismatch that nobody
 * declared a policy for, because the silent answer used to be `stretch` and a
 * stretched face is not something a review catches from a filename.
 */
export const FIT_MODES = Object.freeze(["pad", "cover", "stretch"]);
export const EDIT_MANIFEST_SCHEMA_VERSION = 1;

function normalizeOverlay(overlay, path) {
  assertObject(overlay, path);
  assertNoUnknownKeys(overlay, OVERLAY_FIELDS, path);
  const fromSeconds = numberInRange(overlay.from_seconds, `${path}.from_seconds`, 0, 3_600, 0);
  const toSeconds =
    overlay.to_seconds === undefined
      ? undefined
      : numberInRange(overlay.to_seconds, `${path}.to_seconds`, 0, 3_600);
  // Where a caption sits is only meaningful together with where the subject was
  // at that moment, so the checked timestamps travel with the layout.
  let checkedAt = null;
  if (overlay.subject_checked_at_seconds !== undefined) {
    if (!Array.isArray(overlay.subject_checked_at_seconds) || overlay.subject_checked_at_seconds.length === 0) {
      throw new TypeError(`${path}.subject_checked_at_seconds must be a non-empty array of seconds`);
    }
    checkedAt = overlay.subject_checked_at_seconds.map((value, position) =>
      numberInRange(value, `${path}.subject_checked_at_seconds[${position}]`, 0, 3_600),
    );
    for (let position = 1; position < checkedAt.length; position += 1) {
      if (checkedAt[position] <= checkedAt[position - 1]) {
        throw new TypeError(`${path}.subject_checked_at_seconds must increase`);
      }
    }
    for (const value of checkedAt) {
      if (value < fromSeconds || (toSeconds !== undefined && value > toSeconds)) {
        throw new RangeError(
          `${path}.subject_checked_at_seconds must fall inside the overlay window ${fromSeconds}..${toSeconds ?? "end"}`,
        );
      }
    }
  }

  return {
    asset: requiredString(overlay.asset, `${path}.asset`),
    x: overlay.x === undefined ? 0 : integerInRange(overlay.x, `${path}.x`, -20_000, 20_000, 0),
    y: overlay.y === undefined ? 0 : integerInRange(overlay.y, `${path}.y`, -20_000, 20_000, 0),
    ...(overlay.scale === undefined ? {} : { scale: requiredString(overlay.scale, `${path}.scale`) }),
    from_seconds: fromSeconds,
    ...(toSeconds === undefined ? {} : { to_seconds: toSeconds }),
    ...(overlay.note === undefined ? {} : { note: optionalString(overlay.note, `${path}.note`) }),
    ...(checkedAt === null ? {} : { subject_checked_at_seconds: checkedAt }),
    ...(overlay.subject_clear === undefined ? {} : { subject_clear: Boolean(overlay.subject_clear) }),
  };
}

/**
 * Retiming of a clip segment.
 *
 * `frames` always means output frames, so speed only changes how much source is
 * consumed: source_seconds = frames / frame_rate * factor. That keeps the
 * timeline arithmetic in frames, where it belongs.
 */
function normalizeSpeed(speed, path) {
  if (speed === undefined) return { factor: 1, interpolation: "none" };
  if (typeof speed === "number") {
    return { factor: numberInRange(speed, `${path}.speed`, 0.1, 4), interpolation: "none" };
  }
  assertObject(speed, path);
  assertNoUnknownKeys(speed, SPEED_FIELDS, path);
  return {
    factor: numberInRange(speed.factor, `${path}.factor`, 0.1, 4, 1),
    // Motion interpolation costs minutes of CPU per segment and warps fast
    // movement, so it is never the default.
    interpolation: oneOf(speed.interpolation, `${path}.interpolation`, RETIME_INTERPOLATIONS, "none"),
  };
}

function normalizeMotion(motion, path) {
  if (motion === undefined) return { type: "none" };
  assertObject(motion, path);
  assertNoUnknownKeys(motion, MOTION_FIELDS, path);
  const type = oneOf(motion.type, `${path}.type`, MOTION_TYPES, "none");
  if (type === "scroll") {
    return { type, to_y: numberInRange(motion.to_y, `${path}.to_y`, 0, 100_000) };
  }
  if (type === "zoom_in") {
    return { type, amount: numberInRange(motion.amount, `${path}.amount`, 0.001, 1, 0.06) };
  }
  return { type };
}

function normalizeReviewReference(value, path) {
  const raw = requiredString(value, path, { max: 1_000 });
  // A note that happens to end in ".json" is not a thing; a path that happens to
  // sit next to the manifest is, so the slash is not required.
  const kind = raw.toLowerCase().endsWith(".json") ? "path" : "note";
  return { kind, value: raw };
}

function normalizeSegment(segment, index) {
  const path = `segments[${index}]`;
  assertObject(segment, path);
  assertNoUnknownKeys(segment, SEGMENT_FIELDS, path);
  const kind = oneOf(segment.kind, `${path}.kind`, SEGMENT_KINDS);
  const id = identifier(segment.id ?? `seg${index + 1}`, `${path}.id`);

  // Durations are frame counts, never seconds. A segment asked for in seconds
  // (-t 1.6 at 24 fps) silently rounds down to 38 frames and shifts everything
  // downstream, which is exactly how a finished master lost two frames.
  const frames =
    kind === "still_sequence"
      ? (() => {
          if (!Array.isArray(segment.frames) || segment.frames.length === 0) {
            throw new TypeError(`${path}.frames must be a non-empty array of frame counts`);
          }
          return segment.frames.map((value, position) =>
            integerInRange(value, `${path}.frames[${position}]`, 1, 100_000),
          );
        })()
      : integerInRange(segment.frames, `${path}.frames`, 1, 100_000);

  const sources =
    kind === "still_sequence"
      ? (() => {
          if (!Array.isArray(segment.sources) || segment.sources.length === 0) {
            throw new TypeError(`${path}.sources must be a non-empty array`);
          }
          if (segment.sources.length !== frames.length) {
            throw new TypeError(
              `${path} has ${segment.sources.length} sources but ${frames.length} frame counts`,
            );
          }
          return segment.sources.map((value, position) =>
            requiredString(value, `${path}.sources[${position}]`),
          );
        })()
      : null;

  if (kind !== "still_sequence" && segment.sources !== undefined) {
    throw new TypeError(`${path}.sources is only valid for a still_sequence`);
  }

  // Only a generated clip carries usable production audio; graphics are silent
  // and get a generated silent track so concat sees one uniform stream layout.
  const speed = normalizeSpeed(segment.speed, `${path}.speed`);
  if (kind !== "clip" && segment.speed !== undefined) {
    // A still already states its length in frames; retiming it would mean nothing.
    throw new TypeError(`${path}.speed is only valid for a clip segment`);
  }

  const audio =
    kind === "clip" ? oneOf(segment.audio, `${path}.audio`, ["source", "silent"], "source") : "silent";
  if (kind !== "clip" && segment.audio !== undefined && segment.audio !== "silent") {
    throw new TypeError(`${path}.audio must be silent for a ${kind} segment`);
  }

  return {
    id,
    kind,
    ...(kind === "still_sequence"
      ? { sources }
      : { source: requiredString(segment.source, `${path}.source`) }),
    frames,
    in_seconds: numberInRange(segment.in_seconds, `${path}.in_seconds`, 0, 3_600, 0),
    speed,
    audio,
    motion: normalizeMotion(segment.motion, `${path}.motion`),
    ...(segment.fit === undefined ? {} : { fit: oneOf(segment.fit, `${path}.fit`, FIT_MODES) }),
    overlays: (segment.overlays ?? []).map((overlay, position) =>
      normalizeOverlay(overlay, `${path}.overlays[${position}]`),
    ),
    // Two shapes exist in real manifests: a path to a review file and a free
    // note. Classified here, resolved by assembly, so this stays pure.
    ...(segment.review === undefined
      ? {}
      : { review: normalizeReviewReference(segment.review, `${path}.review`) }),
  };
}

function normalizeAudio(audio) {
  if (audio === undefined) return null;
  assertObject(audio, "audio");
  assertNoUnknownKeys(audio, AUDIO_FIELDS, "audio");

  let music = null;
  if (audio.music !== undefined) {
    assertObject(audio.music, "audio.music");
    assertNoUnknownKeys(audio.music, MUSIC_FIELDS, "audio.music");
    music = {
      source: requiredString(audio.music.source, "audio.music.source"),
      gain: numberInRange(audio.music.gain, "audio.music.gain", 0, 4, 1),
      ...(audio.music.fade_out_from_seconds === undefined
        ? {}
        : {
            fade_out_from_seconds: numberInRange(
              audio.music.fade_out_from_seconds,
              "audio.music.fade_out_from_seconds",
              0,
              3_600,
            ),
            fade_out_seconds: numberInRange(
              audio.music.fade_out_seconds,
              "audio.music.fade_out_seconds",
              0.01,
              60,
              1,
            ),
          }),
      // Synthesized beds are legitimate but must never be presented as licensed.
      rights: oneOf(audio.music.rights, "audio.music.rights", ["licensed", "synthesized_placeholder"]),
    };
  }

  let voiceover = null;
  if (audio.voiceover !== undefined) {
    assertObject(audio.voiceover, "audio.voiceover");
    assertNoUnknownKeys(audio.voiceover, VOICEOVER_FIELDS, "audio.voiceover");
    if (!Array.isArray(audio.voiceover.cues) || audio.voiceover.cues.length === 0) {
      throw new TypeError("audio.voiceover.cues must be a non-empty array");
    }
    const cues = audio.voiceover.cues.map((cue, index) => {
      const path = `audio.voiceover.cues[${index}]`;
      assertObject(cue, path);
      assertNoUnknownKeys(cue, CUE_FIELDS, path);
      return {
        id: identifier(cue.id, `${path}.id`),
        source: requiredString(cue.source, `${path}.source`),
        at_seconds: numberInRange(cue.at_seconds, `${path}.at_seconds`, 0, 3_600),
        // Declared rather than probed, so ducking windows stay a pure function of
        // the manifest; assembly checks the declaration against the file.
        duration_seconds: numberInRange(cue.duration_seconds, `${path}.duration_seconds`, 0.01, 600),
      };
    });
    const cueIds = new Set();
    for (const cue of cues) {
      if (cueIds.has(cue.id)) throw new TypeError(`Duplicate voiceover cue id: ${cue.id}`);
      cueIds.add(cue.id);
    }
    voiceover = {
      cues,
      // A separately produced voice: synthesized speech is never presented as recorded.
      rights: oneOf(audio.voiceover.rights, "audio.voiceover.rights", ["synthesized_tts", "recorded_licensed"]),
      ...(audio.voiceover.provenance === undefined
        ? {}
        : { provenance: requiredString(audio.voiceover.provenance, "audio.voiceover.provenance") }),
    };
  }

  // Native audio defaults to speech, which is what every earlier cut assumed.
  // Effects (a cat's meow, a keyboard) keep their own relative level instead of
  // being normalized to dialogue loudness, and duck under the voiceover.
  let native = null;
  if (audio.native !== undefined) {
    assertObject(audio.native, "audio.native");
    assertNoUnknownKeys(audio.native, NATIVE_FIELDS, "audio.native");
    native = {
      role: oneOf(audio.native.role, "audio.native.role", NATIVE_ROLES, "speech"),
      gain: numberInRange(audio.native.gain, "audio.native.gain", 0, 8, 1),
      duck_level: numberInRange(audio.native.duck_level, "audio.native.duck_level", 0, 1, 0.35),
    };
  }

  let speech = { normalize_lufs: -15, gain: 1 };
  if (audio.speech !== undefined) {
    assertObject(audio.speech, "audio.speech");
    assertNoUnknownKeys(audio.speech, SPEECH_FIELDS, "audio.speech");
    speech = {
      normalize_lufs: numberInRange(audio.speech.normalize_lufs, "audio.speech.normalize_lufs", -40, 0, -15),
      gain: numberInRange(audio.speech.gain, "audio.speech.gain", 0, 4, 1),
    };
  }

  let ducking = { level: 0.16, ramp_seconds: 0.4 };
  if (audio.ducking !== undefined) {
    assertObject(audio.ducking, "audio.ducking");
    assertNoUnknownKeys(audio.ducking, DUCKING_FIELDS, "audio.ducking");
    ducking = {
      level: numberInRange(audio.ducking.level, "audio.ducking.level", 0, 1, 0.16),
      ramp_seconds: numberInRange(audio.ducking.ramp_seconds, "audio.ducking.ramp_seconds", 0, 5, 0.4),
    };
  }

  const targetLufs = audio.target_lufs ?? [-20, -16];
  if (!Array.isArray(targetLufs) || targetLufs.length !== 2) {
    throw new TypeError("audio.target_lufs must be a [floor, ceiling] pair");
  }
  const [floor, ceiling] = targetLufs.map((value, index) =>
    numberInRange(value, `audio.target_lufs[${index}]`, -40, 0),
  );
  if (floor >= ceiling) throw new RangeError("audio.target_lufs must be ordered [floor, ceiling]");

  return {
    music,
    voiceover,
    ...(native ? { native } : {}),
    speech,
    ducking,
    // alimiter auto-levels by default and pushes peaks back up to the ceiling;
    // assembly disables that, so this really is a ceiling.
    limit: numberInRange(audio.limit, "audio.limit", 0.1, 1, 0.84),
    target_lufs: [floor, ceiling],
  };
}

/** Sorted, non-overlapping windows: a cue that runs across a cut is one window, not two. */
function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Validate and normalize a declarative edit manifest.
 *
 * The manifest is the single description of a cut: what plays, for how many
 * frames, what is drawn over it and how the mix is built. Assembly executes it
 * without making creative decisions of its own.
 */
export function normalizeEditManifest(input) {
  assertObject(input, "edit manifest");
  assertNoUnknownKeys(input, TOP_LEVEL_FIELDS, "edit manifest");
  if ((input.schema_version ?? EDIT_MANIFEST_SCHEMA_VERSION) !== EDIT_MANIFEST_SCHEMA_VERSION) {
    throw new RangeError(`edit manifest schema_version must be ${EDIT_MANIFEST_SCHEMA_VERSION}`);
  }

  assertObject(input.output ?? {}, "output");
  assertNoUnknownKeys(input.output ?? {}, OUTPUT_FIELDS, "output");
  const output = {
    width: integerInRange(input.output?.width, "output.width", 16, 8_192, 720),
    height: integerInRange(input.output?.height, "output.height", 16, 8_192, 1_280),
    frame_rate: integerInRange(input.output?.frame_rate, "output.frame_rate", 1, 240, 24),
    audio_sample_rate: integerInRange(
      input.output?.audio_sample_rate,
      "output.audio_sample_rate",
      8_000,
      192_000,
      48_000,
    ),
    masters_root: requiredString(input.output?.masters_root, "output.masters_root"),
    ...(input.output?.fit === undefined
      ? {}
      : { fit: oneOf(input.output.fit, "output.fit", FIT_MODES) }),
  };

  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw new TypeError("edit manifest.segments must be a non-empty array");
  }
  const segments = input.segments.map(normalizeSegment);

  const ids = new Set();
  for (const segment of segments) {
    if (ids.has(segment.id)) throw new TypeError(`Duplicate segment id: ${segment.id}`);
    ids.add(segment.id);
  }

  // Timeline positions are derived, never authored: a hand-written start time
  // that disagrees with the frame counts is a defect waiting to happen.
  let frameCursor = 0;
  const timeline = segments.map((segment) => {
    const frames = Array.isArray(segment.frames)
      ? segment.frames.reduce((sum, value) => sum + value, 0)
      : segment.frames;
    const entry = {
      ...segment,
      start_frame: frameCursor,
      total_frames: frames,
      start_seconds: frameCursor / output.frame_rate,
      duration_seconds: frames / output.frame_rate,
    };
    frameCursor += frames;
    return entry;
  });

  const audio = normalizeAudio(input.audio);
  const totalSeconds = frameCursor / output.frame_rate;
  for (const cue of audio?.voiceover?.cues ?? []) {
    if (cue.at_seconds + cue.duration_seconds > totalSeconds + 1e-3) {
      throw new RangeError(
        `Voiceover cue ${cue.id} ends at ${cue.at_seconds + cue.duration_seconds} s, after the ${totalSeconds} s timeline`,
      );
    }
  }
  // Native effects are not speech: they neither duck the music nor claim a window.
  const nativeIsSpeech = (audio?.native?.role ?? "speech") === "speech";
  const speechWindows = mergeWindows([
    ...timeline
      .filter((segment) => nativeIsSpeech && segment.kind === "clip" && segment.audio === "source")
      .map((segment) => [segment.start_seconds, segment.start_seconds + segment.duration_seconds]),
    ...(audio?.voiceover?.cues ?? []).map((cue) => [cue.at_seconds, cue.at_seconds + cue.duration_seconds]),
  ]);

  return {
    schema_version: EDIT_MANIFEST_SCHEMA_VERSION,
    ...(input.project_id === undefined
      ? {}
      : { project_id: requiredString(input.project_id, "project_id") }),
    variant_id: identifier(input.variant_id, "variant_id"),
    output,
    segments: timeline,
    audio,
    // Ducking windows are derived from which segments carry speech, so the mix
    // cannot drift out of sync with the cut.
    speech_windows: speechWindows,
    total_frames: frameCursor,
    total_seconds: frameCursor / output.frame_rate,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}
