---
name: generate-seedance-video
description: "Prepare, validate, submit, and track Seedance video jobs through a configured API provider. Use for Seedance 2.5 or 2.0 text, image, multimodal reference, video edit, and video extend workflows with storyboard-led action, continuity, native audio, or mixed image/video/audio control."
---

# Generate Seedance Video

Turn one approved shot or short sequence into a reproducible Seedance request. Prefer visual references and a concise timeline over an over-specified wall of cinematic language.

## Project execution boundary

In this repository, use EVOLINK and the project allowlist; another gateway needs an explicit user decision. Within a full production workflow, begin from the frozen plan's `script compose` request, preserving `metadata.production`, the script binding and project-specific jobs root. An existing named legacy waiver replaces only the script-plan requirement for its listed shot_ids; it does not authorize new shots. Prompt-writing guidance below describes the content to encode in the plan, not permission to replace a composed prompt by hand. A linked retry may change one recorded variable through the retry workflow.

Before retry, `submission_unknown` reconciliation, or retiring a reference, read [job recovery](../produce-short-video/references/job-recovery.md). Preserve all take versions and approvals; polling failure alone cannot authorize another submission.

## Entry contract

Require or derive:

- stable `shot_id`, narrative purpose, duration, ratio, and delivery resolution;
- global subject, wardrobe, location, mood, palette, and audio intent;
- one edit beat per timeline interval;
- character, location, object, storyboard, source-video, or audio references with explicit roles;
- provider, exact model choice, budget/retry boundary, and plan/execute intent;
- rights, likeness, and provider-policy status.

If the user selected BytePlus ModelArk, read [references/byteplus-api.md](references/byteplus-api.md) before building the payload.
For this repository's EVOLINK runtime, read [references/evolink-api.md](references/evolink-api.md) and use its explicit model allowlist and CLI execution boundary.

## Resolve capabilities

Discover and persist `provider`, exact `model_id`, revision when exposed, endpoint, and discovery time. Validate the current input limits, duration, ratios, resolution tiers, audio generation, last-frame return, callbacks/polling, content policy, and incompatible fields.

Do not transfer fields from an older Seedance version. In particular, validate whether the selected model supports seeds, fixed-camera flags, frame-count duration, or legacy prompt switches before sending them.

## Prepare the visual plan

1. Make a storyboard with one panel per intended edit beat.
2. Make compact character and location sheets rather than one overloaded collage.
3. Check screen direction, wardrobe, prop state, geography, shot variety, and reference/output aspect ratios.
4. Assign each reference one job. Remove references that compete for the same property.
5. Use a previous accepted last frame as the next start reference when consecutive continuity matters and the provider supports it.

Inside a `$produce-short-video` project, references arrive through `node src/cli.mjs assets add`
and must clear `node src/cli.mjs assets check --model seedance-2.5 --mode <mode>` before
submission. Seedance 2.5 is the project default when `model` is omitted; select Seedance 2.0
explicitly when it is required. The check reports the image/video/audio budget for the selected mode.

Generate a cheaper draft before the final resolution whenever the provider exposes a draft tier and the user approved the expected cost.

## Write the timeline prompt

Start with a compact global block:

- subject and invariant identity;
- wardrobe and key props;
- environment and time of day;
- visual style, palette, and lighting;
- music/ambience and exact dialogue.

Then add chronological beats such as `0-3s`, `3-6s`, and `6-9s`. Give each interval one main action, one camera instruction, and one resulting state. Describe causal physical interactions. Keep enough time for the action; when a beat can be edited deterministically, do it in post.

Quote dialogue exactly when the API recommends quoted speech. Do not ask the model to render critical captions, UI, labels, or logos reliably; add them during editing.

## Build and submit the job

Save:

- a normalized request with creative intent and reference roles;
- the exact provider payload with secrets redacted;
- input hashes, capability snapshot, policy result, estimated cost, and idempotency key.

If execution is authorized:

1. validate reference accessibility, MIME types, durations, totals, and aspect ratios;
2. persist the request before submission;
3. submit once and immediately save the remote task ID/raw response;
4. poll or receive callbacks for that existing task;
5. download the original output, optional last frame, and metadata to a unique take directory;
6. never resubmit because polling or download temporarily failed.

## Handoff and QA

Return the resolved capability snapshot, normalized timeline, reference-role map, redacted payload, task status, output paths, and deviations. Invoke `$review-generated-video` before accepting the take.

Pay special attention to:

- reference adherence across every beat rather than only the opening frame;
- action causality, contact, gravity, and anatomy;
- cut timing and whether the requested beats were skipped;
- identity and wardrobe drift;
- native audio, lip sync, dialogue accuracy, and unwanted music;
- text/logo corruption and aspect-ratio jumps.

## Reference

- [BytePlus Seedance 2.0 API snapshot and payload rules](references/byteplus-api.md)
- [EVOLINK Seedance 2.5/2.0 adapter and exact model IDs](references/evolink-api.md)
