---
name: generate-kling-3-video
description: "Prepare, validate, submit, and track Kling 3 video-generation jobs through a configured API provider. Use for Kling 3 text-to-video, image-to-video, start/end-frame transitions, native-audio clips, or provider-supported multi-shot generation, especially when framing, expression, and controlled short-form movement matter."
---

# Generate Kling 3 Video

Convert one approved shot into a reproducible Kling 3 request. Resolve the provider's exact model and schema before using any advertised feature.

## Project execution boundary

In this repository, use EVOLINK and the project allowlist; another gateway needs an explicit user decision. Within a full production workflow, begin from the frozen plan's `script compose` request, preserving `metadata.production`, the script binding and project-specific jobs root. An existing named legacy waiver replaces only the script-plan requirement for its listed shot_ids; it does not authorize new shots. Prompt-writing guidance below describes the content to encode in the plan, not permission to replace a composed prompt by hand. A linked retry may change one recorded variable through the retry workflow.

Before retry, `submission_unknown` reconciliation, or retiring a reference, read [job recovery](../produce-short-video/references/job-recovery.md). Preserve all take versions and approvals; polling failure alone cannot authorize another submission.

## Entry contract

Require or derive:

- `shot_id`, purpose, duration target, and 9:16-safe composition;
- subject, action, environment, camera, lighting/style, and end state;
- exact dialogue/VO/SFX/music intent when audio is requested;
- first frame, last frame, and other references with rights and stable paths/URLs;
- configured provider, budget/retry boundary, and whether to plan or execute.

If called from `$produce-short-video`, preserve its identifiers and continuity bible.

## Resolve capabilities first

1. Query provider documentation, model catalog, or capability endpoint.
2. Record `provider`, exact `model_id`, model revision when exposed, endpoint, and discovery time.
3. Verify supported modes, input counts/types, duration, aspect ratio, resolution, native audio, multi-shot, negative prompt, webhooks, and idempotency.
4. Reject unknown or incompatible fields instead of passing them through.
5. Never map Kling O3/Omni to Kling 3 or vice versa as a fallback.

Kling's first-party product announcement describes Video 3.0 as supporting up to 15-second clips, native audio, and multi-shot storytelling. A provider may expose a smaller or differently named subset. Read [references/provider-notes.md](references/provider-notes.md) before implementation.

## Choose one generation mode

- **Text to video:** use when composition may vary and exploration is acceptable.
- **Image to video:** use when the opening composition, product, character, or location must be anchored.
- **Start and end frames:** use for a controlled bridge, reveal, transformation, or match cut. Do not assume this can be combined with multi-shot.
- **Multi-shot:** use when a single task must preserve scene logic across related angles. Keep the beat count within the resolved provider limit.

Use the smallest control surface that solves the shot. More simultaneous references and constraints can reduce stability.

## Write the prompt

Use this order:

1. shot size and camera behavior;
2. anchored subject and identity details;
3. one primary action with cause and effect;
4. environment and interaction;
5. lighting, palette, and texture;
6. sound and exact quoted dialogue, if supported;
7. explicit final state for transitions.

Describe visible events, not abstract praise. Keep names, wardrobe, handedness, screen direction, and props identical to the continuity bible. Put important dialogue early; split a long dialogue shot instead of asking the model to maintain lip sync across an overloaded clip.

For multi-shot mode, label beats or timestamps only when the provider accepts them. Give each beat one camera setup and one narrative action. Do not duplicate global context in every beat.

## Build and validate the job

Save two representations:

- a normalized request containing creative intent and provider-independent fields;
- the exact provider payload after capability mapping.

Include input hashes, requested output settings, policy checks, estimated cost, and an idempotency key. Validate reference accessibility without exposing credentials in URLs or logs.

If execution is authorized:

1. submit exactly once;
2. persist raw response and remote task ID immediately;
3. poll or receive a webhook for that task ID;
4. distinguish queued/running/succeeded/failed/expired states;
5. download the original result and metadata to a unique take directory;
6. never resubmit automatically after a network or polling error unless submission is proven absent.

## Handoff and QA

Return the resolved capability snapshot, normalized intent, exact payload with secrets redacted, task status, output paths, and any deviation from the shot plan. Invoke `$review-generated-video` before calling the take successful.

Reject or reroute when:

- the provider lacks the requested mode;
- identity, motion, dialogue, or end-frame constraints conflict;
- a clip is too long or dense for reliable continuity;
- exact text/logo placement is required in-generation;
- reference rights or synthetic-media policy are unresolved.

## Reference

- [Kling 3 provider notes and normalized contract](references/provider-notes.md)
