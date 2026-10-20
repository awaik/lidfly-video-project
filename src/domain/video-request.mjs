import { resolve } from "node:path";
import {
  assertNoUnknownKeys,
  assertObject,
  httpUrl,
  identifier,
  integerInRange,
  oneOf,
  optionalString,
  requiredString,
} from "../core/validation.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "shot_id",
  "take_id",
  "provider",
  "model",
  "mode",
  "prompt",
  "duration_seconds",
  "aspect_ratio",
  "resolution",
  "generate_audio",
  "references",
  "options",
  "callback_url",
  "metadata",
  "narration",
]);
const REFERENCE_FIELDS = new Set(["asset_id", "role", "url", "path", "rights_status"]);
export const DEFAULT_VIDEO_MODEL = "seedance-2.5";
export const MODEL_MODES = Object.freeze({
  "seedance-2.5": Object.freeze([
    "text_to_video",
    "image_to_video",
    "reference_to_video",
    "video_edit",
    "video_extend",
  ]),
  "seedance-2.0": Object.freeze(["text_to_video", "image_to_video", "reference_to_video"]),
  "kling-o3": Object.freeze([
    "text_to_video",
    "image_to_video",
    "reference_to_video",
    "video_edit",
  ]),
  "kling-v3": Object.freeze(["text_to_video", "image_to_video"]),
});
const ADAPTIVE_ONLY_MODES = Object.freeze(["image_to_video", "video_edit", "video_extend"]);
const ADAPTIVE_ONLY_CHOICES = Object.freeze(["adaptive"]);
const SEEDANCE_ASPECT_RATIOS = Object.freeze([
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
  "adaptive",
]);
const KLING_ASPECT_RATIOS = Object.freeze(["16:9", "9:16", "1:1"]);

/** Every ratio any route accepts. A value outside this set is a typo, not a routing choice. */
export const ASPECT_RATIOS = Object.freeze([
  ...new Set([...SEEDANCE_ASPECT_RATIOS, ...KLING_ASPECT_RATIOS]),
]);

const KLING_RESOLUTIONS = Object.freeze(["720p", "1080p", "4k"]);
const RESOLUTIONS_BY_MODEL = Object.freeze({
  "seedance-2.5": Object.freeze(["480p", "720p"]),
  "seedance-2.0": Object.freeze(["480p", "720p", "1080p"]),
  "kling-o3": KLING_RESOLUTIONS,
  "kling-v3": KLING_RESOLUTIONS,
});
export const REFERENCE_ROLES = [
  "start_frame",
  "end_frame",
  "identity",
  "wardrobe",
  "environment",
  "object",
  "composition",
  "style",
  "storyboard",
  "reference_image",
  "reference_video",
  "reference_audio",
  "source_video",
];

function normalizeReference(reference, index) {
  assertObject(reference, `references[${index}]`);
  assertNoUnknownKeys(reference, REFERENCE_FIELDS, `references[${index}]`);
  const assetId = identifier(reference.asset_id, `references[${index}].asset_id`);
  const role = oneOf(reference.role, `references[${index}].role`, REFERENCE_ROLES);
  const hasUrl = reference.url !== undefined;
  const hasPath = reference.path !== undefined;
  if (hasUrl === hasPath) {
    throw new TypeError(`references[${index}] must contain exactly one of url or path`);
  }
  if (hasPath && ["reference_video", "reference_audio", "source_video"].includes(role)) {
    throw new TypeError(
      `references[${index}].path is unsupported for ${role}; local uploads currently support images only`,
    );
  }
  return {
    asset_id: assetId,
    role,
    ...(hasUrl
      ? { url: httpUrl(reference.url, `references[${index}].url`) }
      : { path: resolve(requiredString(reference.path, `references[${index}].path`)) }),
    rights_status: oneOf(
      reference.rights_status,
      `references[${index}].rights_status`,
      ["approved", "not_required"],
    ),
  };
}

function normalizeNarration(narration) {
  if (narration === undefined) return undefined;
  assertObject(narration, "narration");
  assertNoUnknownKeys(narration, new Set(["text", "language", "voice"]), "narration");
  return {
    text: requiredString(narration.text, "narration.text"),
    language: oneOf(narration.language, "narration.language", ["ru"], "ru"),
    voice: oneOf(
      narration.voice,
      "narration.voice",
      ["female", "neutral", "male", "ru_zhadyra", "ru_roman"],
      "neutral",
    ),
  };
}

function normalizeDuration(value, model, mode) {
  if (model === "seedance-2.5") {
    const fallback = mode === "video_edit" ? -1 : 5;
    const duration = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(duration)) {
      throw new RangeError("duration_seconds must be -1 (auto) or an integer from 4 to 30");
    }
    if (mode === "video_edit") {
      if (duration !== -1) {
        throw new RangeError("Seedance 2.5 video_edit requires duration_seconds -1 (follow input)");
      }
      return duration;
    }
    if (duration !== -1 && (duration < 4 || duration > 30)) {
      throw new RangeError("duration_seconds must be -1 (auto) or an integer from 4 to 30");
    }
    return duration;
  }

  const durationMax = model === "seedance-2.0" ? 15 : mode === "reference_to_video" ? 10 : 15;
  const durationMin = model === "seedance-2.0" ? 4 : 3;
  return integerInRange(value, "duration_seconds", durationMin, durationMax, 5);
}

export function isAdaptiveOnlyMode(model, mode) {
  return model === "seedance-2.5" && ADAPTIVE_ONLY_MODES.includes(mode);
}

/**
 * Which aspect ratios a route accepts, and what it falls back to.
 *
 * Exported because the shot-plan checker has to reject an impossible target
 * before a plan is frozen. A second copy of this table there would drift, and
 * the drift would only surface as a provider rejection after payment.
 */
export function aspectRatioChoicesFor(model, mode) {
  if (isAdaptiveOnlyMode(model, mode)) {
    return { choices: ADAPTIVE_ONLY_CHOICES, fallback: "adaptive" };
  }
  if (["seedance-2.5", "seedance-2.0"].includes(model)) {
    return { choices: SEEDANCE_ASPECT_RATIOS, fallback: "9:16" };
  }
  return { choices: KLING_ASPECT_RATIOS, fallback: "9:16" };
}

/**
 * Which resolutions a model accepts. Seedance 2.5 stops at 720p, so a 1080p
 * target is a routing decision, not a knob.
 */
export function resolutionChoicesFor(model) {
  return RESOLUTIONS_BY_MODEL[model] ?? KLING_RESOLUTIONS;
}

export function normalizeVideoRequest(input) {
  assertObject(input, "request");
  assertNoUnknownKeys(input, TOP_LEVEL_FIELDS, "request");
  if (input.schema_version !== undefined && input.schema_version !== 1) {
    throw new RangeError("schema_version must be 1");
  }
  if (input.provider !== undefined && input.provider !== "evolink") {
    throw new RangeError("provider must be evolink");
  }

  const model = oneOf(input.model, "model", Object.keys(MODEL_MODES), DEFAULT_VIDEO_MODEL);
  const modeChoices = MODEL_MODES[model];
  const mode = oneOf(input.mode, "mode", modeChoices, "text_to_video");
  const defaultAudio =
    model === "seedance-2.5" || !["reference_to_video", "video_edit"].includes(mode);
  const aspectRatio = aspectRatioChoicesFor(model, mode);

  const references = (input.references ?? []).map(normalizeReference);
  const ids = new Set();
  for (const reference of references) {
    if (ids.has(reference.asset_id)) throw new TypeError(`duplicate asset_id: ${reference.asset_id}`);
    ids.add(reference.asset_id);
  }

  return {
    schema_version: 1,
    shot_id: identifier(input.shot_id, "shot_id"),
    take_id: identifier(input.take_id, "take_id"),
    provider: "evolink",
    model,
    mode,
    prompt: optionalString(input.prompt, "prompt", { max: 10_000, allowEmpty: true }) ?? "",
    duration_seconds: normalizeDuration(input.duration_seconds, model, mode),
    aspect_ratio: oneOf(
      input.aspect_ratio,
      "aspect_ratio",
      aspectRatio.choices,
      aspectRatio.fallback,
    ),
    resolution: oneOf(input.resolution, "resolution", resolutionChoicesFor(model), "720p"),
    generate_audio:
      input.generate_audio === undefined ? defaultAudio : Boolean(input.generate_audio),
    references,
    options: input.options ?? {},
    ...(input.callback_url
      ? { callback_url: httpUrl(input.callback_url, "callback_url", { httpsOnly: true }) }
      : {}),
    metadata: input.metadata ?? {},
    ...(input.narration ? { narration: normalizeNarration(input.narration) } : {}),
  };
}

export function shouldUseExternalNarration({ narration, nativeAudioStatus }) {
  if (!narration?.text) return false;
  return ["missing", "unusable"].includes(nativeAudioStatus);
}
