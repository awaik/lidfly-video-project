# EVOLINK Seedance 2.5 and 2.0 adapter

Research snapshot: 2026-08-14. Re-open the [EVOLINK Seedance 2.5 guide](https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-overview) before changing the adapter or executing a paid task. Seedance 2.5 is the first catalog entry and the request default when `model` is omitted; there is no silent fallback if its route fails.

## Exact model allowlist

The project accepts model family and mode separately. Resolve exact IDs only through `src/providers/evolink/model-catalog.mjs`; never concatenate them.

Seedance 2.5:

| Mode | Exact EVOLINK model ID |
| --- | --- |
| text-to-video | `seedance-2.5-text-to-video` |
| image-to-video | `seedance-2.5-image-to-video` |
| reference-to-video | `seedance-2.5-reference-to-video` |
| video edit | `seedance-2.5-video-edit` |
| video extend | `seedance-2.5-video-extend` |

Seedance 2.0 remains available only when selected explicitly:

| Mode | Standard | Fast | Mini |
| --- | --- | --- | --- |
| text-to-video | `seedance-2.0-text-to-video` | `seedance-2.0-fast-text-to-video` | `seedance-2.0-mini-text-to-video` |
| image-to-video | `seedance-2.0-image-to-video` | `seedance-2.0-fast-image-to-video` | `seedance-2.0-mini-image-to-video` |
| reference-to-video | `seedance-2.0-reference-to-video` | `seedance-2.0-fast-reference-to-video` | `seedance-2.0-mini-reference-to-video` |

Standard, Fast, and Mini variants apply only to Seedance 2.0. The adapter rejects unsupported model, mode, variant, resolution, duration, ratio, and reference combinations before any upload or paid submission.

## Seedance 2.5 payload boundaries

- Duration is an integer from 4–30 seconds or `-1` for automatic duration. Video Edit accepts only `-1` because output follows the first input video.
- Resolution is `480p` or `720p`. Output format is `mp4` or `mov`.
- Text-to-Video and Reference-to-Video accept fixed ratios or `adaptive`. Image-to-Video, Video Edit, and Video Extend accept only `adaptive`.
- Image-to-Video requires one `start_frame` and accepts one optional `end_frame`.
- Reference-to-Video accepts up to 30 images, 10 videos, and 10 audio clips; at least one of those modalities is required, so audio-only conditioning is valid for this route.
- Video Edit and Video Extend require one `source_video`. It is written first in `video_urls`; up to nine additional reference videos plus 30 images and 10 audio clips may follow within provider duration/body limits.
- `generate_audio` defaults to `true` and has no video-rate surcharge. For Video Edit and Video Extend this is not an original-track preservation switch: EVOLINK documents `true` as generated synchronized audio and `false` as silent output, and exposes no `keep_original_sound` parameter for Seedance 2.5. Do not assume the source track survives; preserve or remux it during assembly when the shot requires it.
- `content_filter: false` is a paid 1.1x mature-mode choice, not a safety bypass.
- `web_search` is valid only for Text-to-Video. Keep edit/extend intent out of Reference-to-Video prompts; use the exact edit or extend route instead.

## Project execution contract

- API base: `https://api.evolink.ai`
- Submit: `POST /v1/videos/generations`
- Status: `GET /v1/tasks/{task_id}`
- Local image upload: `POST https://files-api.evolink.ai/api/v1/files/upload/base64`
- Auth secret: `EVOLINK_API_KEY`
- Generated result URLs expire; download them into a unique job output path immediately after completion.

Plan without remote side effects:

```bash
npm run video -- plan --request <request.json>
```

Only an explicit `--execute` may submit the paid task. The workflow writes the immutable request and provider payload before POST, persists the returned task ID, and blocks automatic resubmission after an ambiguous POST outcome.

Use native `generate_audio` when approved by the shot plan. Invoke Komend only after `$review-generated-video` marks required narration missing or unusable.
