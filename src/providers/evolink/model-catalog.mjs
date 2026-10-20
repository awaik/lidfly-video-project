import { assertNoUnknownKeys, assertObject, oneOf, requiredString } from "../../core/validation.mjs";
import {
  EVOLINK_MATURE_MODE_MULTIPLIER,
  EVOLINK_MODELS,
  EVOLINK_USD_PER_CREDIT,
  MODE_CAPACITY,
} from "./models.mjs";

export { EVOLINK_MODELS } from "./models.mjs";

const IMAGE_ROLES = new Set([
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
]);

/** Single source for local reference-file limits shared by ingestion, planning, and submission. */
export function referenceFileLimits(model) {
  const configuration = EVOLINK_MODELS[model];
  if (!configuration) throw new RangeError(`Unknown model: ${model}`);
  return configuration.reference_file_limits;
}

/** How many references of each kind a mode accepts, for preflight advice before any paid call. */
export function describeModeCapacity(model, mode) {
  const modes = MODE_CAPACITY[model];
  if (!modes) throw new RangeError(`Unknown model: ${model}`);
  const capacity = modes[mode];
  if (!capacity) {
    throw new RangeError(`${model} does not support mode ${mode}; use one of: ${Object.keys(modes).join(", ")}`);
  }
  return Object.freeze({
    model,
    mode,
    ...Object.fromEntries(
      Object.entries(capacity).map(([key, value]) => [
        key,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    ),
  });
}

/**
 * What a job is expected to cost, before any paid call.
 *
 * Only measured routes produce a number; anything else returns unknown_rate so
 * callers can say "not known" instead of quoting an invented figure. Credits are
 * exact (EVOLINK bills per second at a fixed credit rate); the USD figure carries
 * FX drift and is labelled accordingly.
 */
export function estimateJobCost(request) {
  const configuration = EVOLINK_MODELS[request.model];
  if (!configuration) throw new RangeError(`Unknown model: ${request.model}`);

  const pricing = configuration.pricing;
  const variant =
    request.model === "seedance-2.0" ? (request.options?.variant ?? "standard") : null;
  const key = variant ? `${variant}:${request.resolution}` : request.resolution;
  const creditsPerSecond = pricing?.credits_per_second?.[key];

  if (typeof creditsPerSecond !== "number") {
    return Object.freeze({
      status: "unknown_rate",
      model: request.model,
      route: key,
      reason: pricing
        ? `No measured price for ${request.model} ${key}; only ${Object.keys(pricing.credits_per_second).join(", ")} were measured`
        : `No measured price for ${request.model} in this workspace`,
    });
  }

  // Mature mode is a documented 1.1x billing multiplier, not a safety switch.
  const multiplier =
    request.options?.content_filter === false ? EVOLINK_MATURE_MODE_MULTIPLIER : 1;
  const credits = Math.round(creditsPerSecond * request.duration_seconds * multiplier * 1e4) / 1e4;
  const usd = Math.round(credits * EVOLINK_USD_PER_CREDIT * 1e3) / 1e3;

  return Object.freeze({
    status: "estimated",
    model: request.model,
    route: key,
    billing_rule: pricing.billing_rule,
    credits_per_second: creditsPerSecond,
    duration_seconds: request.duration_seconds,
    ...(multiplier === 1 ? {} : { mature_mode_multiplier: multiplier }),
    credits,
    usd,
    usd_precision: "approximate: EVOLINK charges credits and converts at the live CNY/USD rate",
    source: pricing.source,
  });
}

function groupReferences(request, referenceUrls) {
  const grouped = new Map();
  for (const reference of request.references) {
    const resolved = referenceUrls?.[reference.asset_id] ?? reference.url;
    if (!resolved) throw new TypeError(`reference ${reference.asset_id} requires upload before submission`);
    const values = grouped.get(reference.role) ?? [];
    values.push(resolved);
    grouped.set(reference.role, values);
  }
  return grouped;
}

function onlyRoles(request, allowed) {
  const unsupported = request.references.filter((item) => !allowed.has(item.role));
  if (unsupported.length) {
    throw new TypeError(
      `${request.model}/${request.mode} does not support reference role(s): ${unsupported.map((x) => x.role).join(", ")}`,
    );
  }
}

function exactlyOne(grouped, role, { required = false } = {}) {
  const values = grouped.get(role) ?? [];
  if (values.length > 1) throw new TypeError(`reference role ${role} accepts only one asset`);
  if (required && values.length !== 1) throw new TypeError(`reference role ${role} is required`);
  return values[0];
}

function imageReferenceUrls(request, grouped, excluded = new Set()) {
  return request.references
    .filter((reference) => IMAGE_ROLES.has(reference.role) && !excluded.has(reference.role))
    .map((reference) => grouped.get(reference.role)?.shift())
    .filter(Boolean);
}

function normalizeMultiShot(raw, durationSeconds, { intelligenceAllowed }) {
  if (raw === undefined) return undefined;
  assertObject(raw, "options.multi_shot");
  assertNoUnknownKeys(raw, new Set(["strategy", "shots"]), "options.multi_shot");
  const strategies = intelligenceAllowed ? ["customize", "intelligence"] : ["customize"];
  const strategy = oneOf(raw.strategy, "options.multi_shot.strategy", strategies, "customize");
  if (strategy === "intelligence") {
    if (raw.shots?.length) throw new TypeError("intelligence multi-shot must not include shots");
    return { multi_shot: true, shot_type: "intelligence" };
  }
  if (!Array.isArray(raw.shots) || raw.shots.length < 1 || raw.shots.length > 6) {
    throw new TypeError("customize multi-shot requires 1 to 6 shots");
  }
  const shots = raw.shots.map((shot, index) => {
    assertObject(shot, `options.multi_shot.shots[${index}]`);
    assertNoUnknownKeys(
      shot,
      new Set(["prompt", "duration_seconds"]),
      `options.multi_shot.shots[${index}]`,
    );
    const prompt = requiredString(shot.prompt, `options.multi_shot.shots[${index}].prompt`, {
      max: 512,
    });
    const duration = Number(shot.duration_seconds);
    if (!Number.isInteger(duration) || duration < 1 || duration > durationSeconds) {
      throw new RangeError(`options.multi_shot.shots[${index}].duration_seconds is invalid`);
    }
    return { index: index + 1, prompt, duration: String(duration) };
  });
  const total = shots.reduce((sum, shot) => sum + Number(shot.duration), 0);
  if (total !== durationSeconds) {
    throw new RangeError(`multi-shot durations must total ${durationSeconds} seconds, got ${total}`);
  }
  return { multi_shot: true, shot_type: "customize", multi_prompt: shots };
}

function normalizeElements(raw, max) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > max) {
    throw new TypeError(`options.element_ids must be an array with at most ${max} values`);
  }
  return raw.map((value, index) => ({
    element_id: requiredString(value, `options.element_ids[${index}]`),
  }));
}

function buildSeedance(request, grouped) {
  const is25 = request.model === "seedance-2.5";
  assertObject(request.options, "options");
  assertNoUnknownKeys(
    request.options,
    new Set(is25
      ? ["content_filter", "web_search", "output_format"]
      : ["variant", "content_filter", "web_search"]),
    "options",
  );
  const variant = is25
    ? null
    : oneOf(request.options.variant, "options.variant", ["standard", "fast", "mini"], "standard");
  const model = is25
    ? EVOLINK_MODELS[request.model].modes[request.mode]
    : EVOLINK_MODELS[request.model].modes[request.mode][variant];
  const capacity = describeModeCapacity(request.model, request.mode);
  if (!is25 && variant !== "standard" && request.resolution === "1080p") {
    throw new RangeError(`Seedance ${variant} supports only 480p or 720p`);
  }
  if (
    request.options.web_search &&
    (request.mode !== "text_to_video" || (!is25 && variant === "mini"))
  ) {
    throw new TypeError("Seedance web_search is documented only for standard/fast text_to_video");
  }

  const payload = {
    model,
    prompt: requiredString(request.prompt, "prompt"),
    duration: request.duration_seconds,
    quality: request.resolution,
    aspect_ratio: request.aspect_ratio,
    generate_audio: request.generate_audio,
    content_filter: request.options.content_filter !== false,
    ...(is25
      ? { output_format: oneOf(request.options.output_format, "options.output_format", ["mp4", "mov"], "mp4") }
      : {}),
  };

  if (request.mode === "text_to_video") {
    onlyRoles(request, new Set());
    if (request.options.web_search) payload.model_params = { web_search: true };
  } else if (request.mode === "image_to_video") {
    onlyRoles(request, new Set(["start_frame", "end_frame"]));
    const start = exactlyOne(grouped, "start_frame", { required: true });
    const end = exactlyOne(grouped, "end_frame");
    payload.image_urls = end ? [start, end] : [start];
  } else if (request.mode === "reference_to_video") {
    onlyRoles(
      request,
      new Set([
        ...IMAGE_ROLES,
        "reference_video",
        "reference_audio",
        ...(is25 ? [] : ["source_video"]),
      ]),
    );
    const images = imageReferenceUrls(request, grouped);
    const videos = [
      ...(grouped.get("reference_video") ?? []),
      ...(!is25 ? (grouped.get("source_video") ?? []) : []),
    ];
    const audios = grouped.get("reference_audio") ?? [];
    if (images.length > capacity.images) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.images} images`);
    }
    if (videos.length > capacity.videos) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.videos} videos`);
    }
    if (audios.length > capacity.audio) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.audio} audio clips`);
    }
    if (!images.length && !videos.length && (!is25 || !audios.length)) {
      throw new TypeError(
        `Seedance reference_to_video requires at least one ${is25 ? "image, video, or audio" : "image or video"}`,
      );
    }
    if (images.length) payload.image_urls = images;
    if (videos.length) payload.video_urls = videos;
    if (audios.length) payload.audio_urls = audios;
  } else {
    onlyRoles(
      request,
      new Set([...IMAGE_ROLES, "source_video", "reference_video", "reference_audio"]),
    );
    const images = imageReferenceUrls(request, grouped);
    const source = exactlyOne(grouped, "source_video", { required: true });
    const videos = [source, ...(grouped.get("reference_video") ?? [])];
    const audios = grouped.get("reference_audio") ?? [];
    if (images.length > capacity.images) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.images} images`);
    }
    if (videos.length > capacity.videos) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.videos} videos`);
    }
    if (audios.length > capacity.audio) {
      throw new RangeError(`Seedance ${request.mode} accepts at most ${capacity.audio} audio clips`);
    }
    payload.video_urls = videos;
    if (images.length) payload.image_urls = images;
    if (audios.length) payload.audio_urls = audios;
  }
  if (request.callback_url) payload.callback_url = request.callback_url;
  return payload;
}

function buildKling(request, grouped) {
  assertObject(request.options, "options");
  const isO3 = request.model === "kling-o3";
  const capacity = describeModeCapacity(request.model, request.mode);
  const allowedOptions = isO3
    ? new Set(["multi_shot", "element_ids", "watermark", "keep_original_sound"])
    : new Set(["multi_shot", "element_ids", "watermark", "negative_prompt"]);
  assertNoUnknownKeys(request.options, allowedOptions, "options");
  const model = EVOLINK_MODELS[request.model].modes[request.mode];
  if (isO3 && ["reference_to_video", "video_edit"].includes(request.mode) && request.resolution === "4k") {
    throw new RangeError(`Kling O3 ${request.mode} supports only 720p or 1080p`);
  }
  const payload = { model };
  const modelParams = {};

  if (!["video_edit"].includes(request.mode)) {
    payload.duration = request.duration_seconds;
  }
  if (!["image_to_video", "video_edit"].includes(request.mode) || isO3) {
    payload.aspect_ratio = request.aspect_ratio;
  }
  payload.quality = request.resolution;

  if (["text_to_video", "image_to_video"].includes(request.mode)) {
    payload.prompt = request.prompt;
    payload.sound = request.generate_audio ? "on" : "off";
    if (!isO3 && request.options.negative_prompt) {
      payload.negative_prompt = requiredString(request.options.negative_prompt, "options.negative_prompt", {
        max: 2500,
      });
    }
    const multiShot = normalizeMultiShot(request.options.multi_shot, request.duration_seconds, {
      intelligenceAllowed: !isO3,
    });
    if (multiShot) Object.assign(modelParams, multiShot);
    if (!multiShot || multiShot.shot_type === "intelligence") {
      requiredString(request.prompt, "prompt", { max: 2500 });
    }
  }

  if (request.mode === "text_to_video") {
    onlyRoles(request, new Set());
    const elements = normalizeElements(request.options.element_ids, capacity.elements);
    if (elements?.length) modelParams.element_list = elements;
  } else if (request.mode === "image_to_video") {
    const allowedRoles = isO3
      ? new Set([...IMAGE_ROLES])
      : new Set(["start_frame", "end_frame"]);
    onlyRoles(request, allowedRoles);
    const start = exactlyOne(grouped, "start_frame", { required: !isO3 });
    const end = exactlyOne(grouped, "end_frame");
    if (start) payload.image_start = start;
    if (end && !start) throw new TypeError("Kling O3 end frame requires a start frame");
    if (end) payload.image_end = end;
    if (isO3) {
      const images = imageReferenceUrls(
        request,
        grouped,
        new Set(["start_frame", "end_frame"]),
      );
      const elements = normalizeElements(request.options.element_ids, capacity.elements);
      if (images.length + (elements?.length ?? 0) > capacity.images_and_elements) {
        throw new RangeError(
          `Kling O3 image mode allows at most ${capacity.images_and_elements} reference images plus elements`,
        );
      }
      if (end && images.length) {
        throw new RangeError("Kling O3 last frame cannot be combined with additional reference images");
      }
      if (!start && images.length === 0) {
        throw new TypeError("Kling O3 image mode requires a start frame or reference image");
      }
      if (images.length) payload.image_urls = images;
      if (elements?.length) modelParams.element_list = elements;
    } else {
      const elements = normalizeElements(request.options.element_ids, capacity.elements);
      if (elements?.length) modelParams.element_list = elements;
    }
  } else {
    if (!isO3) throw new TypeError(`Kling V3 does not support mode ${request.mode}`);
    onlyRoles(request, new Set([...IMAGE_ROLES, request.mode === "video_edit" ? "source_video" : "reference_video"]));
    payload.prompt = requiredString(request.prompt, "prompt", { max: 2500 });
    const videoRole = request.mode === "video_edit" ? "source_video" : "reference_video";
    payload.video_url = exactlyOne(grouped, videoRole, { required: true });
    payload.keep_original_sound = request.options.keep_original_sound !== false;
    const images = imageReferenceUrls(request, grouped);
    const elements = normalizeElements(request.options.element_ids, capacity.elements);
    if (images.length + (elements?.length ?? 0) > capacity.images_and_elements) {
      throw new RangeError(
        `Kling O3 video modes allow at most ${capacity.images_and_elements} images plus elements`,
      );
    }
    if (images.length) payload.image_urls = images;
    if (elements?.length) modelParams.element_list = elements;
    if (request.generate_audio) {
      throw new TypeError(`${request.mode} does not support generated sound; use keep_original_sound or external TTS`);
    }
    if (request.mode === "video_edit") delete payload.aspect_ratio;
  }

  if (request.options.watermark !== undefined) {
    modelParams.watermark_info = { enabled: Boolean(request.options.watermark) };
  }
  if (Object.keys(modelParams).length) payload.model_params = modelParams;
  if (request.callback_url) payload.callback_url = request.callback_url;
  return payload;
}

export function buildEvolinkPayload(request, { referenceUrls } = {}) {
  const grouped = groupReferences(request, referenceUrls);
  const payload =
    request.model === "seedance-2.5" || request.model === "seedance-2.0"
      ? buildSeedance(request, grouped)
      : buildKling(request, grouped);
  return {
    resolved_model_id: payload.model,
    requested_label: EVOLINK_MODELS[request.model].requested_label,
    upstream_family: EVOLINK_MODELS[request.model].upstream_family,
    capability_source: EVOLINK_MODELS[request.model].docs,
    payload,
  };
}

export function listEvolinkModels() {
  return Object.entries(EVOLINK_MODELS).map(([key, value]) => ({
    key,
    requested_label: value.requested_label,
    upstream_family: value.upstream_family,
    modes: Object.keys(value.modes),
    exact_model_ids: value.modes,
    docs: value.docs,
  }));
}
