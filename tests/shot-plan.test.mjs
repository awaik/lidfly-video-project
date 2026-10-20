import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContinuity } from "../src/domain/continuity.mjs";
import { shotPlanFindings } from "../src/domain/shot-plan-checks.mjs";
import { composeShotPrompt } from "../src/domain/shot-prompt.mjs";
import {
  aspectRatioForShot,
  createShotPlan,
  maxEventsForDuration,
  normalizeShotPlan,
  shotPlanHash,
} from "../src/domain/shot-plan.mjs";
import { normalizeVideoRequest } from "../src/domain/video-request.mjs";

function continuity(overrides = {}) {
  return normalizeContinuity({
    project_id: "P-V001",
    global_prompt_block: "Realistic anime, vertical 9:16.",
    negative_prompt_block: "No text.",
    required_anchor_kinds: ["light", "location"],
    anchors: {
      "light.evening": { kind: "light", text: "Copper evening light." },
      "light.midday": { kind: "light", text: "Flat midday sun." },
      "location.bridge": { kind: "location", text: "One rusted footbridge." },
      "location.street": { kind: "location", text: "A brick street." },
      "scale.beast": { kind: "scale", text: "Its back reaches the boy's chest." },
    },
    entities: {
      mark: {
        kind: "character",
        role: "protagonist",
        prompt_text: "A teenage boy about fifteen",
        invariants: ["entirely black eyes"],
        signature_feature: "полностью чёрные глаза",
        requires_close_up: true,
        identity_assets: ["mark-face"],
      },
      beast: {
        kind: "creature",
        prompt_text: "A low six-legged predator",
        identity_assets: ["beast-ref"],
        scale_anchor: "scale.beast",
      },
    },
    ...overrides,
  });
}

function shot(overrides = {}) {
  return {
    shot_id: "S001",
    beat_ids: ["B01"],
    edit_purpose: "установка",
    duration_seconds: 4,
    timeline_seconds: 4,
    shot_size: "wide",
    subject: ["mark"],
    continuity_keys: ["light.evening", "location.bridge"],
    identity_refs: ["mark-face"],
    route: { model: "seedance-2.5", mode: "reference_to_video" },
    events: [{ event_id: "E1", text: "the boy freezes on the span" }],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return normalizeShotPlan({
    project_id: "P-V001",
    source_script: { path: "brief/source.md", sha256: "abc123" },
    target: { duration_seconds_total: 4, model_default: "seedance-2.5" },
    beats: [{ beat_id: "B01", label: "Ловушка", kind: "setup", importance: "required" }],
    shots: [shot()],
    ...overrides,
  });
}

function codes(result) {
  return result.findings.map((item) => item.code);
}

test("the envelope is not part of the plan hash, so freezing does not invalidate it", () => {
  const draft = createShotPlan({
    projectId: "P-V001",
    sourceScript: { path: "brief/source.md", sha256: "abc123" },
    target: { duration_seconds_total: 30 },
  });
  const hash = shotPlanHash(draft);
  const frozen = {
    ...draft,
    status: "frozen",
    plan_hash: hash,
    frozen_at: "2026-08-17T10:00:00.000Z",
    check_snapshot: { ok: true, blockers: 0, warnings: 0, checked_at: "2026-08-17T10:00:00.000Z" },
  };
  assert.equal(shotPlanHash(frozen), hash);
});

test("editing any shot changes the plan hash", () => {
  const before = plan();
  const after = plan({ shots: [shot({ duration_seconds: 5, timeline_seconds: 5 })] });
  assert.notEqual(shotPlanHash(before), shotPlanHash(after));
});

test("a shot has no prompt field: the prompt is assembled, never authored", () => {
  assert.throws(
    () => plan({ shots: [shot({ prompt: "a hand-written prompt with four actions" })] }),
    /unsupported field: prompt/,
  );
});

test("two seconds of screen time buy one event", () => {
  assert.equal(maxEventsForDuration(4), 2);
  assert.equal(maxEventsForDuration(5), 2);
  assert.equal(maxEventsForDuration(6), 3);
  assert.equal(maxEventsForDuration(30), 3);
});

test("four events in a four-second shot are refused", () => {
  // When too many actions are packed into 4s, the model renders only the
  // first and the last event, and the climax never reaches the screen.
  const result = shotPlanFindings({
    plan: plan({
      shots: [
        shot({
          events: [
            { event_id: "E1", text: "the guardian slams both front legs into the rail" },
            { event_id: "E2", text: "the iron pin tears out of its anchor plate" },
            { event_id: "E3", text: "the grating folds" },
            { event_id: "E4", text: "the boy lands in the archway" },
          ],
        }),
      ],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("shot_event_overload"));
  assert.equal(result.ok, false);
});

test("a climax beat may not share its shot with anything else", () => {
  const result = shotPlanFindings({
    plan: plan({
      beats: [{ beat_id: "B01", label: "Обрушение", kind: "climax", importance: "climax" }],
      shots: [
        shot({
          events: [
            { event_id: "E1", text: "the bridge collapses" },
            { event_id: "E2", text: "the boy jumps" },
          ],
        }),
      ],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("climax_not_isolated"));
});

test("a required beat with no shot blocks, an optional one only warns", () => {
  const beats = [
    { beat_id: "B01", label: "Ловушка", importance: "required" },
    { beat_id: "B06", label: "Герой видит решение", importance: "required" },
  ];
  const blocked = shotPlanFindings({ plan: plan({ beats }), continuity: continuity() });
  const missing = blocked.findings.find((item) => item.code === "beat_not_covered");
  assert.equal(missing.level, "blocker");
  assert.equal(missing.beat_id, "B06");

  const relaxed = shotPlanFindings({
    plan: plan({ beats: [beats[0], { ...beats[1], importance: "optional" }] }),
    continuity: continuity(),
  });
  assert.equal(relaxed.findings.find((item) => item.code === "beat_not_covered").level, "warning");
});

test("a shot serving no beat is a paid second with no story function", () => {
  const result = shotPlanFindings({
    plan: plan({ shots: [shot({ beat_ids: [] })] }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("shot_without_beat"));
});

test("the protagonist has to be seen close at least once", () => {
  const result = shotPlanFindings({ plan: plan(), continuity: continuity() });
  const found = result.findings.find((item) => item.code === "protagonist_never_close");
  assert.ok(found);
  // The message names what the audience will lose, not just the rule.
  assert.match(found.message, /полностью чёрные глаза/);

  const withClose = shotPlanFindings({
    plan: plan({ shots: [shot({ shot_size: "close_up" })] }),
    continuity: continuity(),
  });
  assert.ok(!codes(withClose).includes("protagonist_never_close"));
});

test("neighbouring shots in different locations need a declared location change", () => {
  const shots = [
    shot({ shot_id: "S001" }),
    shot({
      shot_id: "S002",
      shot_size: "close_up",
      continuity_keys: ["light.evening", "location.street"],
    }),
  ];
  const result = shotPlanFindings({
    plan: plan({ target: { duration_seconds_total: 8 }, shots }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("neighbor_location_anchor_mismatch"));

  const declared = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 8 },
      shots: [shots[0], { ...shots[1], location_change: true }],
    }),
    continuity: continuity(),
  });
  assert.ok(!codes(declared).includes("neighbor_location_anchor_mismatch"));
});

test("light that flips away and back is the evening-day-evening flicker", () => {
  const shots = [
    shot({ shot_id: "S001" }),
    shot({ shot_id: "S002", continuity_keys: ["light.midday", "location.bridge"] }),
    shot({ shot_id: "S003", shot_size: "close_up" }),
  ];
  const result = shotPlanFindings({
    plan: plan({ target: { duration_seconds_total: 12 }, shots }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("light_anchor_flapping"));

  const declared = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 12 },
      shots: [shots[0], { ...shots[1], time_jump: true }, shots[2]],
    }),
    continuity: continuity(),
  });
  assert.ok(!codes(declared).includes("light_anchor_flapping"));
});

test("an entity with a scale anchor may not appear without it", () => {
  const result = shotPlanFindings({
    plan: plan({
      shots: [shot({ subject: ["beast"], identity_refs: ["beast-ref"], shot_size: "close_up" })],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("scale_anchor_missing"));
});

test("a shot missing a required anchor kind is refused", () => {
  const result = shotPlanFindings({
    plan: plan({ shots: [shot({ continuity_keys: ["location.bridge"], shot_size: "close_up" })] }),
    continuity: continuity(),
  });
  const found = result.findings.find((item) => item.code === "missing_required_anchor_kind");
  assert.match(found.message, /light/);
});

test("an identity in frame without its reference is refused, and unsupported modes are too", () => {
  const missing = shotPlanFindings({
    plan: plan({ shots: [shot({ identity_refs: [], shot_size: "close_up" })] }),
    continuity: continuity(),
  });
  assert.ok(codes(missing).includes("identity_without_reference"));

  const unsupported = shotPlanFindings({
    plan: plan({
      shots: [shot({ shot_size: "close_up", route: { model: "seedance-2.5", mode: "text_to_video" } })],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(unsupported).includes("identity_reference_in_unsupported_mode"));
});

test("unknown anchors, entities and beats are named, not silently ignored", () => {
  const result = shotPlanFindings({
    plan: plan({
      shots: [
        shot({
          beat_ids: ["B99"],
          subject: ["ghost"],
          continuity_keys: ["light.evening", "location.bridge", "prop.lantern"],
        }),
      ],
    }),
    continuity: continuity(),
  });
  const found = codes(result);
  assert.ok(found.includes("unknown_beat_reference"));
  assert.ok(found.includes("unknown_entity"));
  assert.ok(found.includes("unknown_anchor"));
});

test("an identity reference outside the project registry is refused with the command to fix it", () => {
  const result = shotPlanFindings({
    plan: plan({ shots: [shot({ shot_size: "close_up" })] }),
    continuity: continuity(),
    assets: [{ asset_id: "beast-ref" }],
  });
  const found = result.findings.find((item) => item.code === "unknown_identity_asset");
  assert.match(found.message, /assets add --asset-id mark-face/);
});

test("timeline seconds, not generated seconds, are what must add up to the target", () => {
  const ok = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 6.33 },
      shots: [shot({ shot_size: "close_up", duration_seconds: 4, timeline_seconds: 6.33 })],
    }),
    continuity: continuity(),
  });
  assert.ok(!codes(ok).includes("duration_total_mismatch"));
  // 4 s of generation at 0.62x is 6.33 s of timeline: a normal retime, not a finding.
  assert.ok(!codes(ok).includes("retime_ratio_extreme"));

  const extreme = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 12 },
      shots: [shot({ shot_size: "close_up", duration_seconds: 4, timeline_seconds: 12 })],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(extreme).includes("retime_ratio_extreme"));

  const mismatch = shotPlanFindings({
    plan: plan({ target: { duration_seconds_total: 30 }, shots: [shot({ shot_size: "close_up" })] }),
    continuity: continuity(),
  });
  assert.ok(codes(mismatch).includes("duration_total_mismatch"));
});

test("a duration below the provider minimum is caught by the real request builder", () => {
  const result = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 3 },
      shots: [shot({ shot_size: "close_up", duration_seconds: 3, timeline_seconds: 3 })],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("duration_below_provider_minimum"));
});

test("a timeline smuggled into style_note is refused", () => {
  const result = shotPlanFindings({
    plan: plan({
      shots: [shot({ shot_size: "close_up", style_note: "0-2s: he runs, 2-4s: the bridge falls" })],
    }),
    continuity: continuity(),
  });
  assert.ok(codes(result).includes("style_note_contains_timeline"));
});

test("a clean plan produces no blockers", () => {
  const result = shotPlanFindings({
    plan: plan({ shots: [shot({ shot_size: "close_up" })] }),
    continuity: continuity(),
    projectId: "P-V001",
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test("the composed prompt carries style, anchors, entities and every event in order", () => {
  const current = plan({
    shots: [
      shot({
        shot_size: "close_up",
        subject: ["mark", "beast"],
        continuity_keys: ["light.evening", "location.bridge", "scale.beast"],
        identity_refs: ["mark-face", "beast-ref"],
        events: [
          { event_id: "E1", text: "the boy jams a pipe under the pin", window_seconds: [0, 2] },
          { event_id: "E2", text: "the pipe bends under his weight", window_seconds: [2, 4] },
        ],
      }),
    ],
  });
  const { prompt, blocks } = composeShotPrompt({
    plan: current,
    continuity: continuity(),
    shot: current.shots[0],
  });
  assert.deepEqual(
    blocks.map((block) => block.name),
    ["style", "world", "light", "entities", "scale", "framing", "events", "negative"],
  );
  assert.match(prompt, /Realistic anime/);
  assert.match(prompt, /Copper evening light/);
  assert.match(prompt, /entirely black eyes/);
  assert.match(prompt, /0-2s: the boy jams a pipe under the pin/);
  assert.match(prompt, /2-4s: the pipe bends/);
  assert.match(prompt, /No text/);
  // What compose produces must be a request the provider adapter accepts.
  assert.doesNotThrow(() =>
    normalizeVideoRequest({
      shot_id: "S001",
      take_id: "T001",
      mode: "reference_to_video",
      prompt,
      duration_seconds: 4,
      references: [
        { asset_id: "mark-face", role: "identity", url: "https://files.evolink.ai/a.png", rights_status: "approved" },
      ],
    }),
  );
});

test("a target aspect ratio no route accepts is a typo, refused at parse time", () => {
  assert.throws(
    () => plan({ target: { duration_seconds_total: 4, aspect_ratio: "19:6" } }),
    /target\.aspect_ratio must be one of/,
  );
});

test("a ratio the routed model cannot render blocks the plan by name, not by builder noise", () => {
  const result = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 4, aspect_ratio: "21:9", model_default: "kling-v3" },
      shots: [shot({ route: { model: "kling-v3", mode: "text_to_video" }, identity_refs: [] })],
    }),
    continuity: continuity(),
  });

  const found = result.findings.find((item) => item.code === "aspect_ratio_unsupported_by_route");
  assert.equal(found?.level, "blocker");
  assert.match(found.message, /kling-v3\/text_to_video принимает только 16:9, 9:16, 1:1/);
  // One problem, one finding: the payload dry-run must not restate it.
  assert.ok(!codes(result).includes("route_unbuildable"));
});

test("an adaptive route warns that the start frame decides the orientation, not the plan", () => {
  const result = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 4, aspect_ratio: "16:9" },
      shots: [shot({ route: { model: "seedance-2.5", mode: "image_to_video" } })],
    }),
    continuity: continuity(),
  });

  const found = result.findings.find((item) => item.code === "aspect_ratio_from_source");
  assert.equal(found?.level, "warning");
  assert.match(found.message, /стартовый кадр должен быть 16:9/);
  assert.ok(!codes(result).includes("aspect_ratio_unsupported_by_route"));
});

test("a plan of pure graphics still has its delivery shape checked", () => {
  const result = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 4, aspect_ratio: "21:9", model_default: "kling-o3" },
      shots: [shot({ source: "graphics", identity_refs: [], events: [] })],
    }),
    continuity: continuity(),
  });

  const found = result.findings.find((item) => item.code === "aspect_ratio_unsupported_by_route");
  assert.equal(found?.level, "blocker");
  assert.equal(found.shot_id, null, "the target is what is wrong, not any one shot");
});

test("a model that cannot exceed 720p says so in real pixels before the plan is frozen", () => {
  const landscape = shotPlanFindings({
    plan: plan({ target: { duration_seconds_total: 4, aspect_ratio: "16:9" } }),
    continuity: continuity(),
  });
  const found = landscape.findings.find((item) => item.code === "resolution_ceiling");
  assert.equal(found?.level, "warning");
  assert.match(found.message, /seedance-2\.5 не поднимается выше 720p, мастер будет максимум 1280×720/);
  assert.match(found.message, /у kling нет измеренной цены/);

  const vertical = shotPlanFindings({ plan: plan(), continuity: continuity() });
  assert.match(
    vertical.findings.find((item) => item.code === "resolution_ceiling").message,
    /720×1280/,
    "the same ceiling, stated in the orientation the plan targets",
  );

  const headroom = shotPlanFindings({
    plan: plan({
      target: { duration_seconds_total: 4, model_default: "seedance-2.0", resolution_default: "720p" },
      shots: [shot({ route: { model: "seedance-2.0", mode: "reference_to_video" } })],
    }),
    continuity: continuity(),
  });
  assert.ok(!codes(headroom).includes("resolution_ceiling"), "720p on a model that reaches 1080p is a choice");
});

test("an adaptive-only route asks for adaptive, never for the plan target it cannot render", () => {
  const target = { aspect_ratio: "16:9" };
  assert.equal(aspectRatioForShot(target, { model: "seedance-2.5", mode: "text_to_video" }), "16:9");
  assert.equal(aspectRatioForShot(target, { model: "seedance-2.5", mode: "image_to_video" }), "adaptive");
  assert.equal(aspectRatioForShot(target, { model: "seedance-2.5", mode: "video_extend" }), "adaptive");
  // Kling keeps an explicit ratio in every mode it supports.
  assert.equal(aspectRatioForShot(target, { model: "kling-o3", mode: "image_to_video" }), "16:9");
});
