import { hashValue } from "../core/hashing.mjs";
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
import {
  ASPECT_RATIOS,
  MODEL_MODES,
  DEFAULT_VIDEO_MODEL,
  isAdaptiveOnlyMode,
} from "./video-request.mjs";

// Planning route only; never an API model identifier. Capabilities are checked in the UI.
const PLAN_MODEL_MODES = { ...MODEL_MODES, "gemini-browser": ["text_to_video", "image_to_video"] };

export const SHOT_PLAN_SCHEMA_VERSION = 1;
export const PLAN_STATUSES = Object.freeze(["draft", "reviewed", "frozen"]);
export const BEAT_KINDS = Object.freeze(["setup", "development", "turn", "climax", "resolution", "hook"]);
export const BEAT_IMPORTANCE = Object.freeze(["required", "climax", "optional"]);
export const SHOT_SOURCES = Object.freeze(["generated", "graphics", "stock", "reused_take"]);
export const SHOT_SIZES = Object.freeze([
  "extreme_close_up",
  "close_up",
  "medium_close_up",
  "medium",
  "medium_wide",
  "wide",
  "extreme_wide",
  "insert",
]);
export const CLOSE_SHOT_SIZES = Object.freeze(["extreme_close_up", "close_up", "medium_close_up"]);

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "project_id",
  "status",
  "plan_hash",
  "continuity_hash",
  "frozen_at",
  "check_snapshot",
  "review",
  "source_script",
  "target",
  "beats",
  "shots",
]);
// The envelope records what happened TO the plan, never what the plan says.
// Hashing skips it so freezing does not change the hash it is stamping.
const ENVELOPE_FIELDS = ["status", "plan_hash", "continuity_hash", "frozen_at", "check_snapshot", "review"];
const SOURCE_SCRIPT_FIELDS = new Set(["path", "sha256", "title", "captured_at"]);
const TARGET_FIELDS = new Set([
  "duration_seconds_total",
  "duration_tolerance_seconds",
  "aspect_ratio",
  "frame_rate",
  "platform",
  "model_default",
  "resolution_default",
  "audio_mode",
  "generate_audio",
]);
const BEAT_FIELDS = new Set(["beat_id", "label", "script_time", "kind", "importance", "purpose"]);
const SHOT_FIELDS = new Set([
  "shot_id",
  "beat_ids",
  "source",
  "edit_purpose",
  "duration_seconds",
  "timeline_seconds",
  "shot_size",
  "camera",
  "subject",
  "start_state",
  "end_state",
  "events",
  "continuity_keys",
  "identity_refs",
  "route",
  "style_note",
  "dialogue",
  "audio_intent",
  "risk",
  "location_change",
  "time_jump",
  "continue_from",
]);
const EVENT_FIELDS = new Set(["event_id", "text", "window_seconds", "reads_as"]);
const ROUTE_FIELDS = new Set(["model", "mode", "reason", "fallback"]);
const REVIEW_FIELDS = new Set(["record", "reviewer_pass", "plan_hash", "verdict"]);
const CHECK_SNAPSHOT_FIELDS = new Set(["ok", "blockers", "warnings", "checked_at"]);

/**
 * How many separate events one shot can actually render.
 *
 * A four-second Seedance shot given four events played the first and the last
 * and dropped the middle two — including the climax of the scene. Two seconds
 * per event is the floor that survived that lesson.
 */
export function maxEventsForDuration(durationSeconds) {
  return Math.min(3, Math.max(1, Math.floor(durationSeconds / 2)));
}

/**
 * The aspect ratio a shot's request must carry.
 *
 * Adaptive-only routes take their shape from the start frame or the source
 * video, and the provider rejects any explicit ratio there — so the plan target
 * cannot simply be copied through. One answer, shared by the composer that
 * writes requests and the gate that checks them; two would let a hand-written
 * request drift from the frozen plan without anything noticing.
 */
export function aspectRatioForShot(target, route) {
  return isAdaptiveOnlyMode(route.model, route.mode) ? "adaptive" : target.aspect_ratio;
}

function stringArray(value, path, { max = 300 } = {}) {
  const list = value ?? [];
  if (!Array.isArray(list)) throw new TypeError(`${path} must be an array`);
  return list.map((item, index) => requiredString(item, `${path}[${index}]`, { max }));
}

function normalizeEvent(raw, path, durationSeconds) {
  assertObject(raw, path);
  assertNoUnknownKeys(raw, EVENT_FIELDS, path);
  let window = null;
  if (raw.window_seconds !== undefined) {
    if (!Array.isArray(raw.window_seconds) || raw.window_seconds.length !== 2) {
      throw new TypeError(`${path}.window_seconds must be a [start, end] pair`);
    }
    const [start, end] = raw.window_seconds.map((value, index) =>
      numberInRange(value, `${path}.window_seconds[${index}]`, 0, durationSeconds),
    );
    if (end <= start) throw new RangeError(`${path}.window_seconds must end after it starts`);
    window = [start, end];
  }
  return {
    event_id: identifier(raw.event_id, `${path}.event_id`),
    text: requiredString(raw.text, `${path}.text`, { max: 400 }),
    ...(window ? { window_seconds: window } : {}),
    ...(raw.reads_as === undefined
      ? {}
      : { reads_as: requiredString(raw.reads_as, `${path}.reads_as`, { max: 400 }) }),
  };
}

function normalizeRoute(raw, path, target) {
  assertObject(raw ?? {}, path);
  assertNoUnknownKeys(raw ?? {}, ROUTE_FIELDS, path);
  const model = oneOf(raw?.model, `${path}.model`, Object.keys(PLAN_MODEL_MODES), target.model_default);
  return {
    model,
    mode: oneOf(raw?.mode, `${path}.mode`, PLAN_MODEL_MODES[model], "text_to_video"),
    ...(raw?.reason === undefined
      ? {}
      : { reason: requiredString(raw.reason, `${path}.reason`, { max: 600 }) }),
    ...(raw?.fallback === undefined
      ? {}
      : { fallback: requiredString(raw.fallback, `${path}.fallback`, { max: 600 }) }),
  };
}

function normalizeShot(raw, index, target) {
  const path = `shots[${index}]`;
  assertObject(raw, path);
  assertNoUnknownKeys(raw, SHOT_FIELDS, path);
  const durationSeconds = integerInRange(raw.duration_seconds, `${path}.duration_seconds`, 1, 600);
  const events = (raw.events ?? []).map((event, position) =>
    normalizeEvent(event, `${path}.events[${position}]`, durationSeconds),
  );
  if (!Array.isArray(raw.events ?? [])) throw new TypeError(`${path}.events must be an array`);

  return {
    shot_id: identifier(raw.shot_id, `${path}.shot_id`),
    beat_ids: stringArray(raw.beat_ids, `${path}.beat_ids`, { max: 80 }),
    source: oneOf(raw.source, `${path}.source`, SHOT_SOURCES, "generated"),
    edit_purpose: requiredString(raw.edit_purpose, `${path}.edit_purpose`, { max: 600 }),
    duration_seconds: durationSeconds,
    // What the provider renders and what the cut occupies are different numbers
    // the moment a segment is retimed: 4 s of generation became 6.33 s of
    // timeline at 0.62x in the trailer that motivated this schema.
    timeline_seconds: numberInRange(
      raw.timeline_seconds,
      `${path}.timeline_seconds`,
      0.04,
      600,
      durationSeconds,
    ),
    shot_size: oneOf(raw.shot_size, `${path}.shot_size`, SHOT_SIZES),
    ...(raw.camera === undefined
      ? {}
      : { camera: requiredString(raw.camera, `${path}.camera`, { max: 400 }) }),
    subject: stringArray(raw.subject, `${path}.subject`, { max: 80 }),
    ...(raw.start_state === undefined
      ? {}
      : { start_state: requiredString(raw.start_state, `${path}.start_state`, { max: 600 }) }),
    ...(raw.end_state === undefined
      ? {}
      : { end_state: requiredString(raw.end_state, `${path}.end_state`, { max: 600 }) }),
    events,
    continuity_keys: stringArray(raw.continuity_keys, `${path}.continuity_keys`, { max: 120 }),
    identity_refs: stringArray(raw.identity_refs, `${path}.identity_refs`, { max: 80 }),
    route: normalizeRoute(raw.route, `${path}.route`, target),
    // The only free-text slot left in a shot. Everything that decides what the
    // model renders lives in structured fields, so the event count cannot be
    // walked around in prose.
    ...(raw.style_note === undefined
      ? {}
      : { style_note: requiredString(raw.style_note, `${path}.style_note`, { max: 400 }) }),
    dialogue:
      raw.dialogue === undefined || raw.dialogue === null
        ? null
        : requiredString(raw.dialogue, `${path}.dialogue`, { max: 600 }),
    audio_intent: stringArray(raw.audio_intent, `${path}.audio_intent`, { max: 120 }),
    risk: stringArray(raw.risk, `${path}.risk`, { max: 300 }),
    location_change: raw.location_change === undefined ? false : Boolean(raw.location_change),
    time_jump: raw.time_jump === undefined ? false : Boolean(raw.time_jump),
    continue_from:
      raw.continue_from === undefined || raw.continue_from === null
        ? null
        : identifier(raw.continue_from, `${path}.continue_from`),
  };
}

function normalizeBeat(raw, index) {
  const path = `beats[${index}]`;
  assertObject(raw, path);
  assertNoUnknownKeys(raw, BEAT_FIELDS, path);
  return {
    beat_id: identifier(raw.beat_id, `${path}.beat_id`),
    label: requiredString(raw.label, `${path}.label`, { max: 200 }),
    ...(raw.script_time === undefined
      ? {}
      : { script_time: requiredString(raw.script_time, `${path}.script_time`, { max: 40 }) }),
    kind: oneOf(raw.kind, `${path}.kind`, BEAT_KINDS, "development"),
    importance: oneOf(raw.importance, `${path}.importance`, BEAT_IMPORTANCE, "required"),
    ...(raw.purpose === undefined
      ? {}
      : { purpose: requiredString(raw.purpose, `${path}.purpose`, { max: 600 }) }),
  };
}

function normalizeTarget(raw) {
  assertObject(raw ?? {}, "target");
  assertNoUnknownKeys(raw ?? {}, TARGET_FIELDS, "target");
  return {
    duration_seconds_total: numberInRange(
      raw?.duration_seconds_total,
      "target.duration_seconds_total",
      1,
      3_600,
    ),
    duration_tolerance_seconds: numberInRange(
      raw?.duration_tolerance_seconds,
      "target.duration_tolerance_seconds",
      0,
      10,
      0.5,
    ),
    aspect_ratio: oneOf(raw?.aspect_ratio, "target.aspect_ratio", ASPECT_RATIOS, "9:16"),
    frame_rate: integerInRange(raw?.frame_rate, "target.frame_rate", 1, 240, 24),
    ...(raw?.platform === undefined
      ? {}
      : { platform: requiredString(raw.platform, "target.platform", { max: 120 }) }),
    model_default: oneOf(
      raw?.model_default,
      "target.model_default",
      Object.keys(PLAN_MODEL_MODES),
      DEFAULT_VIDEO_MODEL,
    ),
    resolution_default: oneOf(
      raw?.resolution_default,
      "target.resolution_default",
      ["480p", "720p", "1080p", "4k"],
      "720p",
    ),
    ...(raw?.audio_mode === undefined
      ? {}
      : { audio_mode: requiredString(raw.audio_mode, "target.audio_mode", { max: 120 }) }),
    // Whether the video model renders its own soundtrack. Absent keeps the
    // provider default; false is how a voiceover-only project keeps model audio
    // out of every composed request.
    ...(raw?.generate_audio === undefined
      ? {}
      : { generate_audio: requiredBoolean(raw.generate_audio, "target.generate_audio") }),
  };
}

function requiredBoolean(value, path) {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be true or false`);
  return value;
}

function normalizeSourceScript(raw) {
  assertObject(raw ?? {}, "source_script");
  assertNoUnknownKeys(raw ?? {}, SOURCE_SCRIPT_FIELDS, "source_script");
  return {
    path: requiredString(raw?.path, "source_script.path", { max: 1_000 }),
    sha256: requiredString(raw?.sha256, "source_script.sha256", { max: 64 }),
    ...(raw?.title === undefined
      ? {}
      : { title: requiredString(raw.title, "source_script.title", { max: 300 }) }),
    ...(raw?.captured_at === undefined
      ? {}
      : { captured_at: requiredString(raw.captured_at, "source_script.captured_at", { max: 40 }) }),
  };
}

export function createShotPlan({ projectId, sourceScript, target, now = new Date() }) {
  return {
    schema_version: SHOT_PLAN_SCHEMA_VERSION,
    project_id: requiredString(projectId, "project_id"),
    status: "draft",
    plan_hash: null,
    continuity_hash: null,
    frozen_at: null,
    check_snapshot: null,
    review: null,
    source_script: normalizeSourceScript({ ...sourceScript, captured_at: now.toISOString() }),
    target: normalizeTarget(target),
    beats: [],
    shots: [],
  };
}

export function normalizeShotPlan(input) {
  assertObject(input, "shot plan");
  assertNoUnknownKeys(input, TOP_LEVEL_FIELDS, "shot plan");
  if ((input.schema_version ?? SHOT_PLAN_SCHEMA_VERSION) !== SHOT_PLAN_SCHEMA_VERSION) {
    throw new RangeError(`shot plan schema_version must be ${SHOT_PLAN_SCHEMA_VERSION}`);
  }
  const target = normalizeTarget(input.target);

  if (!Array.isArray(input.beats)) throw new TypeError("shot plan.beats must be an array");
  if (!Array.isArray(input.shots)) throw new TypeError("shot plan.shots must be an array");
  const beats = input.beats.map(normalizeBeat);
  const shots = input.shots.map((shot, index) => normalizeShot(shot, index, target));

  const beatIds = new Set();
  for (const beat of beats) {
    if (beatIds.has(beat.beat_id)) throw new TypeError(`Duplicate beat id: ${beat.beat_id}`);
    beatIds.add(beat.beat_id);
  }
  const shotIds = new Set();
  for (const shot of shots) {
    if (shotIds.has(shot.shot_id)) throw new TypeError(`Duplicate shot id: ${shot.shot_id}`);
    shotIds.add(shot.shot_id);
    if (shot.continue_from && !shots.some((entry) => entry.shot_id === shot.continue_from)) {
      throw new TypeError(`${shot.shot_id}.continue_from points at ${shot.continue_from}, which is not in the plan`);
    }
    const eventIds = new Set();
    for (const event of shot.events) {
      if (eventIds.has(event.event_id)) {
        throw new TypeError(`Duplicate event id ${event.event_id} in shot ${shot.shot_id}`);
      }
      eventIds.add(event.event_id);
    }
  }

  let review = null;
  if (input.review !== undefined && input.review !== null) {
    assertObject(input.review, "shot plan.review");
    assertNoUnknownKeys(input.review, REVIEW_FIELDS, "shot plan.review");
    review = {
      record: requiredString(input.review.record, "shot plan.review.record", { max: 1_000 }),
      reviewer_pass: integerInRange(input.review.reviewer_pass, "shot plan.review.reviewer_pass", 1, 99, 1),
      plan_hash: requiredString(input.review.plan_hash, "shot plan.review.plan_hash", { max: 64 }),
      verdict: oneOf(input.review.verdict, "shot plan.review.verdict", ["approve", "revise"]),
    };
  }

  let checkSnapshot = null;
  if (input.check_snapshot !== undefined && input.check_snapshot !== null) {
    assertObject(input.check_snapshot, "shot plan.check_snapshot");
    assertNoUnknownKeys(input.check_snapshot, CHECK_SNAPSHOT_FIELDS, "shot plan.check_snapshot");
    checkSnapshot = {
      ok: Boolean(input.check_snapshot.ok),
      blockers: integerInRange(input.check_snapshot.blockers, "shot plan.check_snapshot.blockers", 0, 10_000, 0),
      warnings: integerInRange(input.check_snapshot.warnings, "shot plan.check_snapshot.warnings", 0, 10_000, 0),
      checked_at: requiredString(input.check_snapshot.checked_at, "shot plan.check_snapshot.checked_at", { max: 40 }),
    };
  }

  return {
    schema_version: SHOT_PLAN_SCHEMA_VERSION,
    project_id: requiredString(input.project_id, "shot plan.project_id"),
    status: oneOf(input.status, "shot plan.status", PLAN_STATUSES, "draft"),
    plan_hash: optionalString(input.plan_hash, "shot plan.plan_hash", { max: 64 }) ?? null,
    continuity_hash: optionalString(input.continuity_hash, "shot plan.continuity_hash", { max: 64 }) ?? null,
    frozen_at: optionalString(input.frozen_at, "shot plan.frozen_at", { max: 40 }) ?? null,
    check_snapshot: checkSnapshot,
    review,
    source_script: normalizeSourceScript(input.source_script),
    target,
    beats,
    shots,
  };
}

/**
 * Hash of what the plan says, ignoring the envelope that records what happened
 * to it. Freezing stamps the hash into the same file without invalidating it,
 * while any edit to a beat, a shot or an event changes it immediately.
 */
export function shotPlanHash(plan) {
  const normalized = normalizeShotPlan(plan);
  const content = { ...normalized };
  for (const field of ENVELOPE_FIELDS) delete content[field];
  return hashValue(content);
}

const REVIEW_RECORD_FIELDS = new Set([
  "schema_version",
  "project_id",
  "plan_hash",
  "reviewer_pass",
  "beat_verdicts",
  "findings",
  "scores",
  "verdict",
  "reviewed_at",
  "reviewer",
]);
const BEAT_VERDICT_FIELDS = new Set(["beat_id", "covered_by", "verdict", "note"]);
const REVIEW_FINDING_FIELDS = new Set(["level", "code", "shot_id", "beat_id", "message"]);

/**
 * A record written by the independent reviewer.
 *
 * Machine blockers are counted by `check`, not taken from here: a reviewer can
 * add findings but can never clear the ones the checks produced.
 */
export function normalizeShotPlanReview(input) {
  assertObject(input, "shot plan review");
  assertNoUnknownKeys(input, REVIEW_RECORD_FIELDS, "shot plan review");
  const beatVerdicts = input.beat_verdicts ?? [];
  if (!Array.isArray(beatVerdicts)) throw new TypeError("shot plan review.beat_verdicts must be an array");
  const findings = input.findings ?? [];
  if (!Array.isArray(findings)) throw new TypeError("shot plan review.findings must be an array");

  return {
    schema_version: SHOT_PLAN_SCHEMA_VERSION,
    project_id: requiredString(input.project_id, "shot plan review.project_id"),
    plan_hash: requiredString(input.plan_hash, "shot plan review.plan_hash", { max: 64 }),
    reviewer_pass: integerInRange(input.reviewer_pass, "shot plan review.reviewer_pass", 1, 99, 1),
    beat_verdicts: beatVerdicts.map((raw, index) => {
      const path = `shot plan review.beat_verdicts[${index}]`;
      assertObject(raw, path);
      assertNoUnknownKeys(raw, BEAT_VERDICT_FIELDS, path);
      const coveredBy = raw.covered_by ?? [];
      if (!Array.isArray(coveredBy)) throw new TypeError(`${path}.covered_by must be an array`);
      return {
        beat_id: identifier(raw.beat_id, `${path}.beat_id`),
        covered_by: coveredBy.map((value, position) => identifier(value, `${path}.covered_by[${position}]`)),
        verdict: oneOf(raw.verdict, `${path}.verdict`, ["pass", "fail"]),
        ...(raw.note === undefined ? {} : { note: requiredString(raw.note, `${path}.note`, { max: 600 }) }),
      };
    }),
    findings: findings.map((raw, index) => {
      const path = `shot plan review.findings[${index}]`;
      assertObject(raw, path);
      assertNoUnknownKeys(raw, REVIEW_FINDING_FIELDS, path);
      return {
        level: oneOf(raw.level, `${path}.level`, ["blocker", "warning"]),
        code: requiredString(raw.code, `${path}.code`, { max: 80 }),
        ...(raw.shot_id === undefined || raw.shot_id === null
          ? {}
          : { shot_id: identifier(raw.shot_id, `${path}.shot_id`) }),
        ...(raw.beat_id === undefined || raw.beat_id === null
          ? {}
          : { beat_id: identifier(raw.beat_id, `${path}.beat_id`) }),
        message: requiredString(raw.message, `${path}.message`, { max: 1_000 }),
      };
    }),
    scores: input.scores === undefined ? null : input.scores,
    verdict: oneOf(input.verdict, "shot plan review.verdict", ["approve", "revise"]),
    reviewed_at: requiredString(input.reviewed_at, "shot plan review.reviewed_at", { max: 40 }),
    reviewer: requiredString(input.reviewer, "shot plan review.reviewer", { max: 200 }),
  };
}

/** Only the request fields that bind it to a frozen plan; nothing else is allowed. */
export function normalizeScriptBinding(input) {
  assertObject(input, "metadata.script");
  assertNoUnknownKeys(input, new Set(["plan_hash"]), "metadata.script");
  return { plan_hash: requiredString(input.plan_hash, "metadata.script.plan_hash", { max: 64 }) };
}
