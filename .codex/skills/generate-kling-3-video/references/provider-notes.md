# Kling 3 provider notes

Research snapshot: 2026-08-04. Provider schemas, names, limits, prices, and access tiers are volatile. Discover them again before submission.

## EVOLINK mapping used by this repository

The project allowlist resolves Kling 3 text and image modes to `kling-v3-text-to-video` and `kling-v3-image-to-video`. It never falls back to O3/Omni. The implementation is in `src/providers/evolink/model-catalog.mjs` and follows the current [EVOLINK text-to-video](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-v3-text-to-video) and [image-to-video](https://evolink.ai/docs/en/api-manual/video-series/kling/kling-v3-image-to-video) schemas.

Submit through `POST https://api.evolink.ai/v1/videos/generations`, persist the returned task ID, and query only `GET /v1/tasks/{task_id}`. Use `EVOLINK_API_KEY`. Paid submission requires the CLI `--execute` boundary.

## First-party baseline

[Kuaishou's Kling AI 3.0 announcement](https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-30-model-ushering-era-where-everyone-can-be) names the video models **Video 3.0** and **Video 3.0 Omni**. For the 3.0 family, it describes:

- generation up to 15 seconds;
- native audio across several languages, accents, and dialects;
- text, image, audio, and video in the broader multimodal workflow;
- text-to-video, image-to-video, reference-to-video, and in-video editing tasks;
- multi-shot instructions and stronger element consistency.

This is a product baseline, not a promise that every API provider exposes every feature. The first-party article does not define a universal public API payload, reference count, resolution list, price, idempotency mechanism, or webhook schema.

## Provider preflight checklist

Record evidence for:

| Capability | Required discovery |
| --- | --- |
| Identity | Exact provider `model_id`, aliases, revision |
| Modes | Text, image, start/end, multi-shot, reference, editing |
| Inputs | MIME types, counts, URL/upload rules, max size/duration |
| Output | Duration, ratio, dimensions/resolution, frame rate, audio |
| Prompt | Length, negative prompt, reference tags, timestamps |
| Async job | Submit endpoint, task ID, status values, expiry |
| Reliability | Idempotency key, callbacks, rate limits, retry guidance |
| Governance | Moderation, likeness/face rules, data retention |
| Cost | Unit, quality multiplier, audio multiplier, estimate source |

If a marketplace exposes both `Kling 3.0` and `Kling O3`, keep their payload builders separate even when the marketplace claims a shared family.

## Normalized request

```json
{
  "schema_version": 1,
  "shot_id": "S001",
  "take_id": "T001",
  "provider": "configured-provider",
  "model_family": "kling-video-3",
  "resolved_model_id": "provider-exact-id",
  "capability_snapshot": {
    "discovered_at": "2026-08-04T12:00:00Z",
    "source": "provider-doc-or-catalog-url",
    "mode": "image_to_video",
    "native_audio": true,
    "multi_shot": false
  },
  "intent": {
    "shot": "medium_close_up",
    "subject": "approved character identity",
    "action": "opens the case, papers react to the wind",
    "environment": "sunlit workshop",
    "camera": "slow push-in",
    "end_state": "product held still toward camera",
    "dialogue": "Это занимает три секунды."
  },
  "references": [
    {
      "role": "start_frame",
      "uri": "signed-or-public-provider-compatible-url",
      "sha256": "..."
    }
  ],
  "output": {
    "aspect_ratio": "9:16",
    "duration_seconds": 4,
    "resolution": "resolved-provider-value",
    "generate_audio": true
  },
  "idempotency_key": "project-S001-T001"
}
```

The adapter maps this object to the provider payload using an allowlist. It must not pass unknown normalized keys through to the API.

## Prompt patterns

### Image-to-video single shot

```text
Medium close-up, slow controlled push-in. [Subject bound to the start image]
opens the closed metal case with the right hand. The latch clicks; a short gust
lifts only the loose papers and hair. Warm workshop light, realistic skin and
metal reflections. The subject says exactly: "Это занимает три секунды."
End with the open case and product held motionless toward camera for half a second.
```

### Multi-shot intent

Use only if the provider documents the mode:

```text
Global: same subject, navy jacket, same workshop, warm morning light.
Beat 1: medium close-up; subject notices the closed case.
Beat 2: insert; right hand opens the latch, one audible click.
Beat 3: medium shot; product is revealed and held still toward camera.
```

Do not add timestamps or provider tags unless the resolved schema supports them.

## Practical QA hypotheses

YouTube workflow tests reviewed for this project suggest testing Kling 3 first for expressive close-ups, image-led framing, controlled start/end transitions, and short multi-shot sequences. They also suggest watching for drift in longer dialogue, overloaded clips, and complex reference combinations. These are hypotheses for draft routing, not guaranteed model behavior.

## Failure handling

- Validation error: keep the response; correct only the rejected field.
- Moderation error: do not evade it; inspect rights/policy and report the provider reason.
- Polling timeout: keep the task ID and resume polling; do not resubmit.
- Succeeded but unusable: review and create a new `take_id`; never overwrite.
- Missing required capability: reroute with explicit approval and record why.
