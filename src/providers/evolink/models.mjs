const DOCS_ROOT = "https://evolink.ai/docs/en/api-manual/video-series";

/**
 * EVOLINK bills video in credits (1 credit = 0.1 CNY) and converts to USD at the
 * live FX rate, so the USD side of any estimate drifts by a few tenths of a percent.
 * Measured across 12 charged jobs on 2026-08-14: 0.014709-0.014722 USD per credit.
 * The credit figures below are exact; USD is an approximation, and every estimate
 * says so via usd_precision.
 */
export const EVOLINK_USD_PER_CREDIT = 0.01472;

/**
 * Mature mode (content_filter: false) is documented as a paid 1.1x multiplier.
 * It is a billing choice, never a safety bypass.
 */
export const EVOLINK_MATURE_MODE_MULTIPLIER = 1.1;
const SEEDANCE_FILE_LIMITS = Object.freeze({
  max_bytes: 30 * 1024 * 1024,
  formats: Object.freeze(["jpeg", "png", "webp"]),
  extensions: Object.freeze([".jpg", ".jpeg", ".png", ".webp"]),
});
const KLING_FILE_LIMITS = Object.freeze({
  max_bytes: 10 * 1024 * 1024,
  formats: Object.freeze(["jpeg", "png"]),
  extensions: Object.freeze([".jpg", ".jpeg", ".png"]),
});

export const EVOLINK_MODELS = Object.freeze({
  "seedance-2.5": Object.freeze({
    requested_label: "Seedance 2.5",
    upstream_family: "ByteDance / BytePlus Seedance 2.5",
    docs: `${DOCS_ROOT}/seedance2.5/seedance-2.5-overview`,
    reference_file_limits: SEEDANCE_FILE_LIMITS,
    pricing: Object.freeze({
      billing_rule: "per_second",
      // Keyed by resolution. Only measured routes appear here; anything absent
      // is reported as unknown rather than extrapolated.
      credits_per_second: Object.freeze({ "720p": 20.09 }),
      source:
        "measured 2026-08-14 across 6 charged jobs (4s and 5s, 720p)",
    }),
    modes: Object.freeze({
      text_to_video: "seedance-2.5-text-to-video",
      image_to_video: "seedance-2.5-image-to-video",
      reference_to_video: "seedance-2.5-reference-to-video",
      video_edit: "seedance-2.5-video-edit",
      video_extend: "seedance-2.5-video-extend",
    }),
  }),
  "seedance-2.0": Object.freeze({
    requested_label: "Seedance 2.0",
    upstream_family: "ByteDance Seedance 2.0",
    docs: `${DOCS_ROOT}/seedance2.0/seedance-2.0-overview`,
    reference_file_limits: SEEDANCE_FILE_LIMITS,
    pricing: Object.freeze({
      billing_rule: "per_second",
      // Keyed by "<variant>:<resolution>"; fast and mini were never run.
      credits_per_second: Object.freeze({ "standard:720p": 13.5 }),
      source:
        "measured 2026-08-05 across 6 charged jobs (4s/5s/6s, standard variant, 720p)",
    }),
    modes: Object.freeze({
      text_to_video: Object.freeze({
        standard: "seedance-2.0-text-to-video",
        fast: "seedance-2.0-fast-text-to-video",
        mini: "seedance-2.0-mini-text-to-video",
      }),
      image_to_video: Object.freeze({
        standard: "seedance-2.0-image-to-video",
        fast: "seedance-2.0-fast-image-to-video",
        mini: "seedance-2.0-mini-image-to-video",
      }),
      reference_to_video: Object.freeze({
        standard: "seedance-2.0-reference-to-video",
        fast: "seedance-2.0-fast-reference-to-video",
        mini: "seedance-2.0-mini-reference-to-video",
      }),
    }),
  }),
  "kling-o3": Object.freeze({
    requested_label: "Kling O3",
    upstream_family: "Kling Video 3.0 Omni (kling-v3-omni)",
    docs: `${DOCS_ROOT}/kling/kling-o3-text-to-video`,
    reference_file_limits: KLING_FILE_LIMITS,
    pricing: Object.freeze({
      billing_rule: "per_second",
      // Keyed by resolution, like Seedance. The rate held to four decimals
      // across every charged job, so a shot's cost is now predictable before
      // submit instead of arriving as unknown_rate.
      credits_per_second: Object.freeze({ "720p": 7.2036 }),
      source:
        "measured 2026-08-27 across 13 charged jobs (3s/4s/5s, 720p): 345.77 credits for 48 seconds",
    }),
    modes: Object.freeze({
      text_to_video: "kling-o3-text-to-video",
      image_to_video: "kling-o3-image-to-video",
      reference_to_video: "kling-o3-reference-to-video",
      video_edit: "kling-o3-video-edit",
    }),
  }),
  "kling-v3": Object.freeze({
    requested_label: "Kling 3.0",
    upstream_family: "Kling Video 3.0",
    docs: `${DOCS_ROOT}/kling/kling-v3-text-to-video`,
    reference_file_limits: KLING_FILE_LIMITS,
    // Never run in this workspace, so there is no measured rate to quote.
    pricing: null,
    modes: Object.freeze({
      text_to_video: "kling-v3-text-to-video",
      image_to_video: "kling-v3-image-to-video",
    }),
  }),
});

export const MODE_CAPACITY = Object.freeze({
  "seedance-2.5": Object.freeze({
    text_to_video: { images: 0, videos: 0, audio: 0, elements: 0, required_roles: [] },
    image_to_video: {
      images: 2,
      videos: 0,
      audio: 0,
      elements: 0,
      image_roles: ["start_frame", "end_frame"],
      required_roles: ["start_frame"],
    },
    reference_to_video: {
      images: 30,
      videos: 10,
      audio: 10,
      elements: 0,
      video_roles: ["reference_video"],
      required_roles: [],
      requires_any: ["image", "video", "audio"],
    },
    video_edit: {
      images: 30,
      videos: 10,
      audio: 10,
      elements: 0,
      video_roles: ["source_video", "reference_video"],
      required_roles: ["source_video"],
    },
    video_extend: {
      images: 30,
      videos: 10,
      audio: 10,
      elements: 0,
      video_roles: ["source_video", "reference_video"],
      required_roles: ["source_video"],
    },
  }),
  "seedance-2.0": Object.freeze({
    text_to_video: { images: 0, videos: 0, audio: 0, elements: 0, required_roles: [] },
    image_to_video: {
      images: 2,
      videos: 0,
      audio: 0,
      elements: 0,
      image_roles: ["start_frame", "end_frame"],
      required_roles: ["start_frame"],
    },
    reference_to_video: {
      images: 9,
      videos: 3,
      audio: 3,
      elements: 0,
      video_roles: ["reference_video", "source_video"],
      required_roles: [],
      requires_any: ["image", "video"],
    },
  }),
  "kling-o3": Object.freeze({
    text_to_video: { images: 0, videos: 0, audio: 0, elements: 7, required_roles: [] },
    image_to_video: {
      images: 7,
      videos: 0,
      audio: 0,
      elements: 3,
      images_and_elements: 7,
      required_roles: [],
      requires_any: ["start_frame", "image"],
    },
    reference_to_video: {
      images: 4,
      videos: 1,
      audio: 0,
      elements: 4,
      images_and_elements: 4,
      video_roles: ["reference_video"],
      required_roles: ["reference_video"],
    },
    video_edit: {
      images: 4,
      videos: 1,
      audio: 0,
      elements: 4,
      images_and_elements: 4,
      video_roles: ["source_video"],
      required_roles: ["source_video"],
    },
  }),
  "kling-v3": Object.freeze({
    text_to_video: { images: 0, videos: 0, audio: 0, elements: 0, required_roles: [] },
    image_to_video: {
      images: 2,
      videos: 0,
      audio: 0,
      elements: 3,
      image_roles: ["start_frame", "end_frame"],
      required_roles: ["start_frame"],
    },
  }),
});
