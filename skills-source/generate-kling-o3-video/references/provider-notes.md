# Kling O3 / Video 3.0 Omni provider notes

Research snapshot: 2026-08-04. `Kling O3` is not a safe universal API identifier.

## EVOLINK mapping used by this repository

EVOLINK explicitly documents the O3 routes as powered by `kling-v3-omni`. The project allowlist maps modes to `kling-o3-text-to-video`, `kling-o3-image-to-video`, `kling-o3-reference-to-video`, and `kling-o3-video-edit`. The implementation is in `src/providers/evolink/model-catalog.mjs`; do not construct another ID from the label.

Submit through `POST https://api.evolink.ai/v1/videos/generations`, persist the returned task ID, and query only `GET /v1/tasks/{task_id}`. Use `EVOLINK_API_KEY`. Paid submission requires the CLI `--execute` boundary.

Primary provider sources: [O3 text-to-video](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-o3-text-to-video), [O3 image-to-video](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-o3-image-to-video), [O3 reference-to-video](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-o3-reference-to-video), and [O3 video edit](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-o3-video-edit).

## Naming rule

[Kuaishou's first-party announcement](https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-30-model-ushering-era-where-everyone-can-be) names **Video 3.0 Omni**, not `Kling O3`. It describes reference-video extraction of visual and voice traits plus a multi-shot storyboard with per-shot duration, size, perspective, narrative content, and camera movement.

Some third-party providers and marketplaces use `Kling O3` or `Kling 3.0 Omni` as catalog labels. Therefore:

1. record the user's requested label separately from the resolved provider `model_id`;
2. accept a mapping only when the provider documents it or returns it from its model catalog;
3. never derive an ID by lowercasing or concatenating a marketing name;
4. never fall back to Video 3.0, O1, 2.6, or another model without approval.

## Capabilities that must be discovered

- reference image/video/audio roles and limits;
- whether visual traits, voice traits, or both are extracted;
- text/image/reference/video-editing modes;
- motion-transfer or source-video controls;
- storyboard, timestamp, keyframe, start/end-frame semantics;
- per-shot and total duration rules;
- native audio and exact dialogue handling;
- output ratios/resolutions/codecs;
- content/likeness restrictions and data retention;
- async state, task expiry, callbacks, idempotency, and price.

Claims such as 4K video, a fixed number of references, or frame-accurate timed keyframes are provider-specific until the selected API documents them.

## Reference-role manifest

```json
{
  "references": [
    {
      "asset_id": "character-front",
      "role": "identity",
      "controls": ["face", "hair"],
      "sha256": "...",
      "rights_status": "approved"
    },
    {
      "asset_id": "wardrobe-side",
      "role": "wardrobe",
      "controls": ["navy_jacket", "silver_zipper"],
      "sha256": "...",
      "rights_status": "approved"
    },
    {
      "asset_id": "walk-cycle",
      "role": "motion",
      "controls": ["pace", "arm_swing"],
      "sha256": "...",
      "rights_status": "approved"
    },
    {
      "asset_id": "station-layout",
      "role": "environment",
      "controls": ["platform_geometry", "sign_position"],
      "sha256": "...",
      "rights_status": "approved"
    }
  ]
}
```

The adapter converts roles into provider tags or content blocks. If the provider has no way to distinguish two critical roles, simplify the job or stop; positional guesswork is not a stable contract.

## Normalized request

```json
{
  "schema_version": 1,
  "shot_id": "S004",
  "take_id": "T002",
  "requested_label": "Kling O3",
  "provider": "configured-provider",
  "model_family": "kling-video-3-omni",
  "resolved_model_id": "provider-exact-id",
  "mode": "reference_to_video",
  "capabilities_discovered_at": "2026-08-04T12:00:00Z",
  "global_continuity": "same approved character, wardrobe, station and dusk light",
  "beats": [
    {
      "duration_seconds": 2.5,
      "shot_size": "wide",
      "camera": "lateral tracking",
      "action": "character follows the motion reference along the platform"
    },
    {
      "duration_seconds": 2.0,
      "shot_size": "close_up",
      "camera": "locked",
      "action": "character stops and looks toward the arriving train"
    }
  ],
  "references": [],
  "output": {
    "aspect_ratio": "9:16",
    "duration_seconds": 5,
    "generate_audio": true
  },
  "idempotency_key": "project-S004-T002"
}
```

## Complexity reduction

Remove controls in this order when the request is overloaded:

1. generated titles/logos/UI that can be composited;
2. decorative style references;
3. unnecessary camera changes;
4. nonessential characters and background actions;
5. native music that will be replaced in post;
6. a second transformation that can become another shot.

Keep identity, key action, geography, and end state unless the creative plan changes.

## QA focus

- confirm that identity references do not blend into each other;
- compare source and result motion at contact points and direction changes;
- verify the storyboard order and each requested end state;
- listen for voice leakage or a voice trait copied from an unintended reference;
- inspect transformations at every frame, not only before and after;
- preserve both the source video and the returned original.
