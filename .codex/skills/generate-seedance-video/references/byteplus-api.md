# BytePlus Seedance 2.0 API snapshot

Research snapshot: 2026-08-04. Primary source: [BytePlus ModelArk video generation API](https://docs.byteplus.com/en/docs/modelark/1520757), last observed as updated 2026-07-31. Re-open the documentation before implementation or submission.

## Endpoint and model

- Create task: `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`
- Documented model ID: `dreamina-seedance-2-0-260128`
- Authentication: provider API key from an environment secret; never embed it in a skill, manifest, URL, or log.
- Jobs are asynchronous. Persist the returned task ID and use the provider's current retrieve-task operation rather than submitting again.
- The observed documentation states task records are retained for seven days. Treat that as a download deadline, not an archival strategy.

Use the current BytePlus SDK/API reference for exact content-block syntax. Do not copy a payload from Seedance 1.x or an unrelated provider.

## Observed input contract

For the documented Seedance 2.0 model:

- zero to nine images;
- zero to three videos;
- zero to three audio inputs;
- optional natural-language prompt;
- audio cannot be the only modality: at least an image or video is required with audio;
- prompt under 1,000 words is recommended;
- each reference video is 2-15 seconds;
- up to three reference videos with combined duration no greater than 15 seconds;
- reference media must be accessible through provider-compatible public or signed URLs;
- video content uses the documented `reference_video` role;
- `return_last_frame` can support consecutive-video workflows;
- `generate_audio` is supported;
- quoted dialogue is recommended for spoken content.

These are preflight limits for this exact documented model/provider snapshot, not for all Seedance providers.

## Observed output controls

- Aspect-ratio choices include `9:16`; use the exact currently documented enum.
- Resolution tiers include 480p, 720p, 1080p, and 4K with model/tier restrictions.
- The observed documentation limits 4K to the standard variant and describes 4K output as H.265 10-bit.
- Fast/Mini variants have different resolution availability; do not infer parity from the standard model.
- Duration is expressed as seconds from 4 through 15, or provider-supported automatic duration (`-1`).
- Frame-count duration is not supported for this model snapshot.
- `seed` and `camera_fixed` are not supported for this model snapshot.

Validate all combinations in the current schema. Unsupported legacy fields should be removed from the adapter, not sent and hoped to be ignored.

## Input preparation

### Images

- Prefer high-quality identity, wardrobe, location, object, and storyboard images with one role each.
- Crop or compose references near the requested output ratio to reduce jumps and unintended reframing.
- Record orientation, dimensions, MIME type, size, hash, and rights status.

### Videos

- Trim motion references to the minimum useful segment before upload.
- Record exact duration and combined reference duration.
- State whether the model should follow motion, composition, identity, camera, rhythm, or audio; do not leave the role implicit.

### Audio

- Record whether it is dialogue, voice identity, music, rhythm, ambience, or SFX.
- Confirm music, voice, and likeness rights.
- Remember that audio requires image or video input in the observed BytePlus contract.

## Normalized request

```json
{
  "schema_version": 1,
  "shot_id": "S006",
  "take_id": "T001",
  "provider": "byteplus-modelark",
  "model_family": "seedance-2",
  "resolved_model_id": "dreamina-seedance-2-0-260128",
  "capabilities_discovered_at": "2026-08-04T12:00:00Z",
  "prompt": {
    "global": "same courier, yellow raincoat, wet station at blue hour, realistic light",
    "beats": [
      {
        "time": "0-3s",
        "camera": "wide lateral tracking",
        "action": "courier runs beside the train; shoes splash through shallow puddles"
      },
      {
        "time": "3-6s",
        "camera": "low close tracking",
        "action": "courier catches the handrail and steps onto the moving train"
      }
    ],
    "dialogue": null,
    "audio": "rain, footsteps, train movement; no music"
  },
  "references": [
    {
      "role": "identity",
      "type": "image",
      "uri": "provider-compatible-url",
      "sha256": "..."
    },
    {
      "role": "storyboard",
      "type": "image",
      "uri": "provider-compatible-url",
      "sha256": "..."
    }
  ],
  "output": {
    "aspect_ratio": "9:16",
    "resolution": "720p",
    "duration_seconds": 6,
    "generate_audio": true,
    "return_last_frame": true
  },
  "idempotency_key": "project-S006-T001"
}
```

The provider adapter converts this normalized object to the current ModelArk content blocks using an allowlist.

## Submission algorithm

1. Load `ARK_API_KEY` or the application's provider-specific secret name from the environment.
2. Verify the exact model remains available.
3. Validate reference URL access without printing signed URLs.
4. Validate counts, media types, individual and total video duration, and the audio co-input rule.
5. Validate duration, ratio, resolution, audio, and last-frame combination.
6. Persist normalized and exact redacted provider requests.
7. Submit once.
8. Atomically persist the returned task ID and raw response.
9. Poll the existing task with bounded backoff and a total wait ceiling.
10. On success, download video, optional last frame, and metadata before provider expiry.
11. Calculate hashes and hand off to `$review-generated-video`.

## Consecutive-shot workflow

When `return_last_frame` is supported and the accepted take ends in the right state:

1. preserve the returned last frame as an output of the accepted take;
2. review it for identity/anatomy before reuse;
3. register it as a new asset with provenance and hash;
4. use it as the next shot's start/composition reference;
5. keep the original character and location references to reduce accumulated drift;
6. do not chain from a rejected take.

## Policy note

BytePlus model policies and trusted real-person asset programs may restrict direct use of real-human face references. Check the current account/provider policy before upload. Never route around a provider restriction or remove provenance to evade moderation.
