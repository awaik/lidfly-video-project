import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_MODES,
  normalizeVideoRequest,
  shouldUseExternalNarration,
} from "../src/domain/video-request.mjs";
import {
  EVOLINK_MODELS,
  buildEvolinkPayload,
  describeModeCapacity,
  estimateJobCost,
  listEvolinkModels,
  referenceFileLimits,
} from "../src/providers/evolink/model-catalog.mjs";

function request(overrides = {}) {
  return normalizeVideoRequest({
    shot_id: "S001",
    take_id: "T001",
    model: "seedance-2.0",
    mode: "text_to_video",
    prompt: "A controlled vertical shot",
    duration_seconds: 5,
    aspect_ratio: "9:16",
    resolution: "720p",
    references: [],
    options: {},
    ...overrides,
  });
}

test("cost estimates reproduce what EVOLINK actually charged", () => {
  // Credit figures are exact and regression-locked against real invoices.
  // USD carries live CNY/USD drift, so it is asserted within a cent.
  const charged = [
    { model: "seedance-2.5", duration: 4, credits: 80.36, usd: 1.182 },
    { model: "seedance-2.5", duration: 5, credits: 100.45, usd: 1.478 },
    { model: "seedance-2.0", duration: 4, credits: 54, usd: 0.795 },
    { model: "seedance-2.0", duration: 5, credits: 67.5, usd: 0.993 },
    { model: "seedance-2.0", duration: 6, credits: 81, usd: 1.192 },
  ];
  for (const { model, duration, credits, usd } of charged) {
    const estimate = estimateJobCost(request({ model, duration_seconds: duration }));
    assert.equal(estimate.status, "estimated");
    assert.equal(estimate.credits, credits, `${model} ${duration}s credits`);
    assert.ok(
      Math.abs(estimate.usd - usd) <= 0.01,
      `${model} ${duration}s: estimated $${estimate.usd}, charged $${usd}`,
    );
    assert.match(estimate.usd_precision, /approximate/);
  }
});

test("unmeasured routes report unknown_rate instead of an invented price", () => {
  const lowerResolution = estimateJobCost(
    request({ model: "seedance-2.5", resolution: "480p" }),
  );
  assert.equal(lowerResolution.status, "unknown_rate");
  assert.match(lowerResolution.reason, /No measured price/);
  assert.equal(lowerResolution.usd, undefined);

  const fastVariant = estimateJobCost(
    request({ model: "seedance-2.0", options: { variant: "fast" } }),
  );
  assert.equal(fastVariant.status, "unknown_rate");
  assert.equal(fastVariant.route, "fast:720p");

  const kling = estimateJobCost(request({ model: "kling-v3", mode: "text_to_video" }));
  assert.equal(kling.status, "unknown_rate");

  assert.throws(() => estimateJobCost({ model: "not-a-model" }), /Unknown model/);
});

test("mature mode is priced as the documented 1.1x billing multiplier", () => {
  const standard = estimateJobCost(request({ model: "seedance-2.5", duration_seconds: 4 }));
  const mature = estimateJobCost(
    request({ model: "seedance-2.5", duration_seconds: 4, options: { content_filter: false } }),
  );
  assert.equal(mature.mature_mode_multiplier, 1.1);
  assert.equal(mature.credits, Math.round(standard.credits * 1.1 * 1e4) / 1e4);
});

test("catalog uses explicit documented EVOLINK model IDs", () => {
  const listedModels = listEvolinkModels();
  const models = Object.fromEntries(listedModels.map((model) => [model.key, model]));
  assert.equal(listedModels[0].key, "seedance-2.5");
  assert.equal(Object.hasOwn(listedModels[0], "is_default"), false);
  assert.deepEqual(models["seedance-2.5"].exact_model_ids, {
    text_to_video: "seedance-2.5-text-to-video",
    image_to_video: "seedance-2.5-image-to-video",
    reference_to_video: "seedance-2.5-reference-to-video",
    video_edit: "seedance-2.5-video-edit",
    video_extend: "seedance-2.5-video-extend",
  });
  assert.equal(
    models["seedance-2.0"].exact_model_ids.text_to_video.standard,
    "seedance-2.0-text-to-video",
  );
  assert.equal(models["kling-o3"].exact_model_ids.text_to_video, "kling-o3-text-to-video");
  assert.equal(models["kling-o3"].upstream_family, "Kling Video 3.0 Omni (kling-v3-omni)");
  assert.equal(models["kling-v3"].exact_model_ids.text_to_video, "kling-v3-text-to-video");
  assert.deepEqual(referenceFileLimits("seedance-2.5").formats, ["jpeg", "png", "webp"]);
  assert.deepEqual(referenceFileLimits("seedance-2.0").formats, ["jpeg", "png", "webp"]);
  assert.deepEqual(referenceFileLimits("kling-o3").formats, ["jpeg", "png"]);
  assert.strictEqual(referenceFileLimits("kling-o3"), referenceFileLimits("kling-v3"));
});

test("domain model modes stay aligned with the EVOLINK allowlist", () => {
  assert.deepEqual(Object.keys(MODEL_MODES), Object.keys(EVOLINK_MODELS));
  for (const [model, modes] of Object.entries(MODEL_MODES)) {
    assert.deepEqual(modes, Object.keys(EVOLINK_MODELS[model].modes), model);
  }
});

test("Seedance 2.5 is selected when a request omits model", () => {
  const normalized = normalizeVideoRequest({
    shot_id: "S025",
    take_id: "T001",
    prompt: "Default route probe",
  });

  assert.equal(normalized.model, "seedance-2.5");
  assert.equal(normalized.mode, "text_to_video");
  assert.equal(normalized.generate_audio, true);
  const result = buildEvolinkPayload(normalized);
  assert.deepEqual(result.payload, {
    model: "seedance-2.5-text-to-video",
    prompt: "Default route probe",
    duration: 5,
    quality: "720p",
    aspect_ratio: "9:16",
    generate_audio: true,
    content_filter: true,
    output_format: "mp4",
  });
});

test("Seedance 2.5 exposes web search, MOV output, and automatic duration", () => {
  const result = buildEvolinkPayload(
    normalizeVideoRequest({
      shot_id: "S025",
      take_id: "T002",
      model: "seedance-2.5",
      prompt: "Use current product context",
      duration_seconds: -1,
      options: { web_search: true, output_format: "mov" },
    }),
  );

  assert.equal(result.payload.model, "seedance-2.5-text-to-video");
  assert.equal(result.payload.duration, -1);
  assert.equal(result.payload.output_format, "mov");
  assert.deepEqual(result.payload.model_params, { web_search: true });
});

test("Seedance 2.5 reference mode accepts audio-only conditioning", () => {
  const result = buildEvolinkPayload(
    normalizeVideoRequest({
      shot_id: "S025",
      take_id: "T003",
      model: "seedance-2.5",
      mode: "reference_to_video",
      prompt: "Use @audio1 as the timing and soundtrack reference",
      references: [
        {
          asset_id: "soundtrack",
          role: "reference_audio",
          url: "https://example.com/soundtrack.mp3",
          rights_status: "approved",
        },
      ],
    }),
  );

  assert.equal(result.payload.model, "seedance-2.5-reference-to-video");
  assert.deepEqual(result.payload.audio_urls, ["https://example.com/soundtrack.mp3"]);
  assert.equal(result.payload.generate_audio, true);
});

test("Seedance 2.5 enforces documented video and audio reference limits", () => {
  const video = (index) => ({
    asset_id: `video-${index}`,
    role: "reference_video",
    url: `https://example.com/video-${index}.mp4`,
    rights_status: "approved",
  });
  const audio = (index) => ({
    asset_id: `audio-${index}`,
    role: "reference_audio",
    url: `https://example.com/audio-${index}.mp3`,
    rights_status: "approved",
  });
  const capacity = describeModeCapacity("seedance-2.5", "reference_to_video");
  const atLimit = {
    shot_id: "S025",
    take_id: "T003-limits",
    model: "seedance-2.5",
    mode: "reference_to_video",
    prompt: "Use the supplied references",
    references: [
      ...Array.from({ length: capacity.videos }, (_, index) => video(index)),
      ...Array.from({ length: capacity.audio }, (_, index) => audio(index)),
    ],
  };

  assert.doesNotThrow(() => buildEvolinkPayload(normalizeVideoRequest(atLimit)));
  assert.throws(
    () =>
      buildEvolinkPayload(
        normalizeVideoRequest({
          ...atLimit,
          references: [
            ...Array.from({ length: capacity.videos + 1 }, (_, index) => video(index)),
            ...Array.from({ length: capacity.audio }, (_, index) => audio(index)),
          ],
        }),
      ),
    /at most 10 videos/,
  );
});

test("Seedance 2.5 video edit and extend keep the source video first", () => {
  const references = [
    {
      asset_id: "motion-reference",
      role: "reference_video",
      url: "https://example.com/motion.mov",
      rights_status: "approved",
    },
    {
      asset_id: "source",
      role: "source_video",
      url: "https://example.com/source.mp4",
      rights_status: "approved",
    },
  ];
  const edit = buildEvolinkPayload(
    normalizeVideoRequest({
      shot_id: "S025",
      take_id: "T004",
      model: "seedance-2.5",
      mode: "video_edit",
      prompt: "Edit @video1 using the motion of @video2",
      references,
    }),
  );
  assert.equal(edit.payload.model, "seedance-2.5-video-edit");
  assert.equal(edit.payload.duration, -1);
  assert.equal(edit.payload.aspect_ratio, "adaptive");
  assert.deepEqual(edit.payload.video_urls, [
    "https://example.com/source.mp4",
    "https://example.com/motion.mov",
  ]);

  const extend = buildEvolinkPayload(
    normalizeVideoRequest({
      shot_id: "S025",
      take_id: "T005",
      model: "seedance-2.5",
      mode: "video_extend",
      prompt: "Extend @video1 forward",
      duration_seconds: 30,
      references: [references[1]],
    }),
  );
  assert.equal(extend.payload.model, "seedance-2.5-video-extend");
  assert.equal(extend.payload.duration, 30);
  assert.deepEqual(extend.payload.video_urls, ["https://example.com/source.mp4"]);
});

test("Seedance 2.5 normalization rejects unsupported route combinations", () => {
  assert.throws(
    () =>
      normalizeVideoRequest({
        shot_id: "S025",
        take_id: "T006",
        model: "seedance-2.5",
        mode: "image_to_video",
        prompt: "Animate the frame",
        aspect_ratio: "9:16",
      }),
    /aspect_ratio must be one of: adaptive/,
  );
  assert.throws(
    () =>
      normalizeVideoRequest({
        shot_id: "S025",
        take_id: "T007",
        model: "seedance-2.5",
        mode: "video_edit",
        prompt: "Edit @video1",
        duration_seconds: 5,
      }),
    /requires duration_seconds -1/,
  );
  assert.throws(
    () =>
      normalizeVideoRequest({
        shot_id: "S025",
        take_id: "T008",
        model: "seedance-2.5",
        prompt: "Resolution probe",
        resolution: "1080p",
      }),
    /resolution must be one of: 480p, 720p/,
  );
  assert.throws(
    () =>
      buildEvolinkPayload(
        normalizeVideoRequest({
          shot_id: "S025",
          take_id: "T009",
          model: "seedance-2.5",
          prompt: "Variant probe",
          options: { variant: "standard" },
        }),
      ),
    /options contains unsupported field: variant/,
  );
});

test("catalog capacities drive non-image builder limits", () => {
  const seedanceCapacity = describeModeCapacity("seedance-2.0", "reference_to_video");
  const video = (index) => ({
    asset_id: `video-${index}`,
    role: "reference_video",
    url: `https://example.com/video-${index}.mp4`,
    rights_status: "approved",
  });
  const audio = (index) => ({
    asset_id: `audio-${index}`,
    role: "reference_audio",
    url: `https://example.com/audio-${index}.mp3`,
    rights_status: "approved",
  });
  assert.doesNotThrow(() =>
    buildEvolinkPayload(
      request({
        mode: "reference_to_video",
        references: [
          ...Array.from({ length: seedanceCapacity.videos }, (_, index) => video(index)),
          ...Array.from({ length: seedanceCapacity.audio }, (_, index) => audio(index)),
        ],
      }),
    ),
  );
  assert.throws(
    () =>
      buildEvolinkPayload(
        request({
          mode: "reference_to_video",
          references: Array.from({ length: seedanceCapacity.videos + 1 }, (_, index) => video(index)),
        }),
      ),
    /at most 3 videos/,
  );

  const klingCapacity = describeModeCapacity("kling-o3", "text_to_video");
  const elementIds = Array.from({ length: klingCapacity.elements }, (_, index) => `element-${index}`);
  assert.doesNotThrow(() =>
    buildEvolinkPayload(request({ model: "kling-o3", options: { element_ids: elementIds } })),
  );
  assert.throws(
    () =>
      buildEvolinkPayload(
        request({ model: "kling-o3", options: { element_ids: [...elementIds, "overflow"] } }),
      ),
    /at most 7 values/,
  );
});

test("Seedance standard text payload is allowlisted", () => {
  const result = buildEvolinkPayload(request({ generate_audio: true }));
  assert.deepEqual(result.payload, {
    model: "seedance-2.0-text-to-video",
    prompt: "A controlled vertical shot",
    duration: 5,
    quality: "720p",
    aspect_ratio: "9:16",
    generate_audio: true,
    content_filter: true,
  });
});

test("Seedance image mode maps start and end frames by explicit role", () => {
  const result = buildEvolinkPayload(
    request({
      mode: "image_to_video",
      references: [
        { asset_id: "start", role: "start_frame", url: "https://example.com/a.jpg", rights_status: "approved" },
        { asset_id: "end", role: "end_frame", url: "https://example.com/b.jpg", rights_status: "approved" },
      ],
    }),
  );
  assert.deepEqual(result.payload.image_urls, [
    "https://example.com/a.jpg",
    "https://example.com/b.jpg",
  ]);
  assert.equal(result.payload.model, "seedance-2.0-image-to-video");
});

test("Seedance does not accept references in text mode", () => {
  assert.throws(
    () =>
      buildEvolinkPayload(
        request({
          references: [
            { asset_id: "image", role: "reference_image", url: "https://example.com/a.jpg", rights_status: "approved" },
          ],
        }),
      ),
    /does not support reference role/,
  );
});

test("Kling O3 resolves to documented Omni provider ID without guessing", () => {
  const result = buildEvolinkPayload(
    request({
      model: "kling-o3",
      mode: "image_to_video",
      references: [
        { asset_id: "start", role: "start_frame", url: "https://example.com/a.jpg", rights_status: "approved" },
        { asset_id: "style", role: "style", url: "https://example.com/style.jpg", rights_status: "approved" },
      ],
      options: { element_ids: ["element-123"] },
    }),
  );
  assert.equal(result.resolved_model_id, "kling-o3-image-to-video");
  assert.equal(result.upstream_family, "Kling Video 3.0 Omni (kling-v3-omni)");
  assert.equal(result.payload.image_start, "https://example.com/a.jpg");
  assert.deepEqual(result.payload.image_urls, ["https://example.com/style.jpg"]);
  assert.deepEqual(result.payload.model_params.element_list, [{ element_id: "element-123" }]);
});

test("Kling O3 accepts a character/style reference without forcing it to be the opening frame", () => {
  const result = buildEvolinkPayload(
    request({
      model: "kling-o3",
      mode: "image_to_video",
      references: [
        {
          asset_id: "characters",
          role: "reference_image",
          url: "https://example.com/characters.png",
          rights_status: "approved",
        },
      ],
      options: {},
    }),
  );
  assert.equal(result.payload.model, "kling-o3-image-to-video");
  assert.deepEqual(result.payload.image_urls, ["https://example.com/characters.png"]);
  assert.ok(!("image_start" in result.payload));
});

test("Kling V3 keeps its payload separate from O3", () => {
  const result = buildEvolinkPayload(
    request({
      model: "kling-v3",
      options: { negative_prompt: "text, warped anatomy" },
    }),
  );
  assert.equal(result.payload.model, "kling-v3-text-to-video");
  assert.equal(result.payload.negative_prompt, "text, warped anatomy");
  assert.equal(result.payload.sound, "on");
  assert.ok(!result.payload.model.includes("o3"));
});

test("custom multi-shot durations must equal total duration", () => {
  assert.throws(
    () =>
      buildEvolinkPayload(
        request({
          model: "kling-v3",
          duration_seconds: 5,
          options: {
            multi_shot: {
              strategy: "customize",
              shots: [
                { prompt: "First", duration_seconds: 2 },
                { prompt: "Second", duration_seconds: 2 },
              ],
            },
          },
        }),
      ),
    /must total 5 seconds/,
  );
});

test("O3 video edit rejects generated sound and accepts source video", () => {
  const normalized = request({
    model: "kling-o3",
    mode: "video_edit",
    generate_audio: false,
    references: [
      { asset_id: "source", role: "source_video", url: "https://example.com/source.mp4", rights_status: "approved" },
    ],
    options: { keep_original_sound: true },
  });
  const result = buildEvolinkPayload(normalized);
  assert.equal(result.payload.model, "kling-o3-video-edit");
  assert.equal(result.payload.video_url, "https://example.com/source.mp4");
  assert.equal(result.payload.keep_original_sound, true);
  assert.ok(!("sound" in result.payload));
  assert.ok(!("aspect_ratio" in result.payload));
});

test("Komend policy is gated by reviewed native audio status", () => {
  const narration = { text: "Тест" };
  assert.equal(shouldUseExternalNarration({ narration, nativeAudioStatus: "present" }), false);
  assert.equal(shouldUseExternalNarration({ narration, nativeAudioStatus: "unreviewed" }), false);
  assert.equal(shouldUseExternalNarration({ narration, nativeAudioStatus: "missing" }), true);
  assert.equal(shouldUseExternalNarration({ narration, nativeAudioStatus: "unusable" }), true);
});

test("normalized request rejects unknown provider fields", () => {
  assert.throws(() => request({ model_id: "guessed-id" }), /unsupported field: model_id/);
});
