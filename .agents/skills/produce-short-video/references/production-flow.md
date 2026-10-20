# Production flow and artifact contract

Use this reference when planning or executing a multi-shot short video. The goal is repeatability: another agent must be able to resume a job without guessing what was submitted or paying for it twice.

## State machine

Each take moves forward through explicit states:

```text
planned
  -> preflighted
  -> approved
  -> submitted
  -> queued/running
  -> succeeded | failed | cancelled | expired
  -> fetched
  -> reviewed
  -> accepted | accepted_with_post | rejected | rerouted
  -> edit_ready
  -> delivered
```

Rules:

- `approved` is required before a paid submission.
- A network timeout after `submitted` does not move the job back to `approved`.
- `failed`, `rejected`, and `rerouted` are retained, not deleted.
- Provider status and local production status are separate fields.
- Only a fetched, reviewed take can become `accepted`.

## Client-aware production tree

```text
projects/<client_id>/
  client.json
  brand/
  series/
  VNNN/
    project.json
    assets.json
    brief/
      shotplan.json
      continuity.json
    assets/
      originals/
    requests/
    reviews/
      shotplan-<hash12>-R<n>.json
    edits/
    variants.json
artifacts/<client_id>/VNNN/
  jobs/
    <shot_id>/
      <take_id>-<request_hash>/
        normalized-request.json
        provider-payload.plan.json
        job.json
        outputs/
          result-01.mp4
          result-01-first.png
          result-01-last.png
        review/
  audio/
  masters/
```

Step 0 of `$produce-short-video` creates or reopens the managed roots before the creative workflow starts. Never construct these paths independently after bootstrap. A legacy alias keeps its registry manifest at `projects/<client_id>/VNNN/project.json`, while `storage.project_root` points to the recognized existing project; it does not move or rewrite legacy files.

Do not create this tree when the user requested only conceptual advice rather than a full workflow. When creating it, never overwrite an existing project or take. Allocate the next stable ID.

## Client manifest

`projects/<client_id>/client.json` records local-only client identity and safe defaults shared by that client's video projects:

```json
{
  "schema_version": 1,
  "client_id": "acme",
  "display_name": "Acme",
  "created_at": "2026-08-05T12:00:00.000Z",
  "storage_policy": "local_only",
  "defaults": {
    "language": null,
    "platforms": [],
    "cta": null
  },
  "rights": {
    "status": "pending",
    "notes": []
  },
  "constraints": []
}
```

## Project manifest

At minimum, `project.json` records:

```json
{
  "schema_version": 1,
  "client_id": "acme",
  "project_id": "ACME-V001",
  "video_number": 1,
  "title": "Видео №1",
  "status": "planning",
  "created_at": "2026-08-05T12:00:00.000Z",
  "approval": {
    "paid_generation": false,
    "max_total_cost": null
  },
  "rights": {
    "status": "pending",
    "notes": []
  },
  "storage": {
    "mode": "standard",
    "project_root": "projects/acme/V001",
    "jobs_root": "artifacts/acme/V001/jobs",
    "audio_root": "artifacts/acme/V001/audio",
    "masters_root": "artifacts/acme/V001/masters"
  }
}
```

The immutable identity is `client_id`, `project_id`, `video_number`, and `created_at`. A repeated `ensure` must not rewrite timestamps, title, or manifests. Bootstrap never changes `approval.paid_generation` to `true`.

## Reference assets manifest

`assets.json` is the project's reference registry, written only by `node src/cli.mjs assets add`:

```json
{
  "schema_version": 1,
  "project_id": "ACME-V001",
  "policy": {
    "originals_immutable": true,
    "retention": "keep every ingested reference original until explicit user-approved cleanup; never overwrite an asset_id"
  },
  "assets": [
    {
      "asset_id": "hero-front",
      "role": "identity",
      "path": "assets/originals/hero-front.jpg",
      "format": "jpeg",
      "mime_type": "image/jpeg",
      "width": 1080,
      "height": 1440,
      "aspect_ratio": "3:4",
      "size_bytes": 812345,
      "sha256": "...",
      "rights_status": "approved",
      "note": "прислано пользователем 2026-08-05",
      "added_at": "2026-08-05T12:00:00.000Z"
    }
  ]
}
```

`format` and dimensions come from the file's magic bytes, not its extension. An `asset_id` is
write-once: re-adding identical content is idempotent, different content under the same ID is an
error. Originals live under `assets/originals/` and are never modified, so a request can always be
replayed from the same inputs. See
[reference-assets.md](reference-assets.md) for intake questions and per-mode capacity.

## Shot intent

`intent.json` is provider-independent:

```json
{
  "schema_version": 1,
  "shot_id": "S001",
  "edit_purpose": "Hook: establish the impossible event",
  "duration_seconds": 3.5,
  "storyboard_panel": "../../creative/storyboard/S001.png",
  "start_state": "Presenter faces camera with closed case",
  "action": "The case opens and emits wind that affects hair and papers",
  "end_state": "Product is visible and held steady for the cut",
  "camera": "Medium close-up, slow push-in, no orbit",
  "continuity_keys": ["character.presenter", "prop.case", "location.desk"],
  "dialogue": "Это занимает три секунды.",
  "audio_intent": ["dialogue", "case_click", "short_wind"],
  "risk": ["lip_sync", "hand_object_contact", "logo_exactness"],
  "route": {
    "primary_skill": "generate-kling-3-video",
    "mode": "image_to_video",
    "reason": "Opening frame and expression need tight control",
    "fallback_skill": "generate-seedance-video"
  }
}
```

## Normalized request

The normalized request binds intent to a provider capability snapshot without copying provider secrets:

```json
{
  "schema_version": 1,
  "shot_id": "S001",
  "take_id": "T001",
  "provider": "configured-provider",
  "model_family": "kling-video-3",
  "resolved_model_id": "provider-exact-id",
  "capabilities_discovered_at": "2026-08-04T12:00:00Z",
  "mode": "image_to_video",
  "prompt": "...",
  "negative_prompt": null,
  "references": [
    {
      "role": "start_frame",
      "path": "assets/originals/S001-start.png",
      "sha256": "...",
      "rights_status": "approved"
    }
  ],
  "output": {
    "aspect_ratio": "9:16",
    "duration_seconds": 4,
    "resolution": "provider-supported-draft"
  },
  "cost": {
    "currency": "USD",
    "estimated": null,
    "approved": false
  },
  "idempotency_key": "ACME-V001-S001-T001",
  "metadata": {
    "production": {
      "client_id": "acme",
      "project_id": "ACME-V001",
      "video_number": 1
    }
  }
}
```

The public video-request contract does not accept top-level `client_id` or `project_id`. Keep production identity in `metadata.production`, preserve other metadata, and invoke the existing planner with the exact returned root:

```bash
node src/cli.mjs plan \
  --request projects/acme/V001/requests/S001-T001.json \
  --jobs-root artifacts/acme/V001/jobs
```

`provider-request.json` contains the exact submitted body and headers only by safe header names. Redact API keys, signed query strings, cookies, bearer tokens, and private callback secrets.

## Job record

Persist the job record immediately after submission:

```json
{
  "schema_version": 1,
  "shot_id": "S001",
  "take_id": "T001",
  "local_status": "submitted",
  "provider_status": "queued",
  "remote_task_id": "task-id-from-provider",
  "submitted_at": "2026-08-04T12:03:00Z",
  "last_polled_at": null,
  "attempt": 1,
  "request_sha256": "...",
  "raw_response_path": "provider-response.json",
  "errors": []
}
```

Before any retry, search by local idempotency key, provider idempotency response, or persisted remote task ID. A failed status check is not a failed submission.

## Production gates

1. **Brief gate:** audience, promise, CTA, duration, and platform are coherent.
2. **Rights gate:** every input and voice/likeness use has a recorded basis.
3. **Shot-plan gate:** every required beat is covered, no shot carries more events than its duration renders, the climax has its own shot, continuity anchors are present in every shot, and the plan is frozen with an independent review recorded. Enforced by `plan` and `submit`; there is no override flag.
4. **Continuity gate:** storyboard and reference pack agree.
5. **Capability gate:** exact provider/model supports requested fields.
6. **Budget gate:** estimate and retry ceiling fit explicit approval.
7. **Generation gate:** immutable request is saved before submission.
8. **Fetch gate:** original output and metadata are preserved.
9. **QA gate:** selected take has evidence and edit handles.
10. **Delivery gate:** encoding, captions, disclosure, and final human review pass.

## YouTube delivery record

Record at least:

- master file hash and duration;
- dimensions/aspect ratio and absence of baked black bars;
- container, video/audio codec, frame rate, sample rate, color space;
- captions and language;
- music/voice/license notes;
- altered/synthetic-content disclosure decision;
- upload status and resulting URL only when publishing is separately authorized.
