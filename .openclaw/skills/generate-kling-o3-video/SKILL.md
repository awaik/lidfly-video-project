---
name: generate-kling-o3-video
description: "Prepare, validate, submit, and track reference-driven Kling O3 or Kling Video 3.0 Omni jobs through a configured API provider. Use for multimodal generation, video editing or transformation, motion transfer, character and scene references, timed keyframes, or other Omni controls that must be verified against the provider's actual model schema."
---

# Generate Kling O3 Video

Handle the multimodal Kling family often labeled `Kling O3`, `Kling 3.0 Omni`, or `Video 3.0 Omni`. The label is ambiguous across providers, so identity resolution is a hard gate.

## Project execution boundary

In this repository, use EVOLINK and the project allowlist; another gateway needs an explicit user decision. Within a full production workflow, begin from the frozen plan's `script compose` request, preserving `metadata.production`, the script binding and project-specific jobs root. An existing named legacy waiver replaces only the script-plan requirement for its listed shot_ids; it does not authorize new shots. Prompt-writing guidance below describes the content to encode in the plan, not permission to replace a composed prompt by hand. A linked retry may change one recorded variable through the retry workflow.

Before retry, `submission_unknown` reconciliation, or retiring a reference, read [job recovery](../produce-short-video/references/job-recovery.md). Preserve all take versions and approvals; polling failure alone cannot authorize another submission.

## Resolve the model identity

Before prompting or submitting:

1. inspect the configured provider's catalog and API documentation;
2. record the exact `model_id`, revision, endpoint, aliases, and capability discovery time;
3. confirm whether the resolved model is the provider's mapping of Video 3.0 Omni;
4. confirm accepted image/video/audio reference roles, editing modes, timestamps/keyframes, output settings, native audio, idempotency, and polling contract;
5. if `Kling O3` is not an available exact model or documented alias, stop and present the available IDs. Do not guess.

Read [references/provider-notes.md](references/provider-notes.md) for the naming caveat and normalized contract.

## Entry contract

Require:

- stable `shot_id`, narrative purpose, desired start/end state, duration, and target ratio;
- reference inventory with a role for every asset: identity, wardrobe, environment, object, motion, composition, start frame, end frame, source video, audio, or style;
- continuity constraints and exact spoken copy;
- provider, plan/execute intent, and budget/retry boundary;
- rights, likeness, and provider-policy status for every input.

Do not upload a reference merely because it exists. Every reference must control a named property.

## Pick the least complex supported mode

- **Reference generation:** preserve people, products, props, or locations across a new shot.
- **Image-to-video / start-end control:** anchor composition or a transition.
- **Video transformation/editing:** keep source motion or timing while changing a permitted visual property.
- **Motion transfer:** apply a motion reference when the provider exposes an explicit role for it.
- **Multi-shot/story mode:** produce related beats inside one task when continuity within the task is more valuable than independent edit control.

If a deterministic edit, title, logo, or composite can be done in post, keep it out of generation.

## Prepare references

- Use sharp, uncluttered front/side/full-body views for identity and costume.
- Use a location sheet or storyboard for spatial continuity.
- Match reference and output aspect ratios where possible.
- Remove redundant or contradictory assets; excess references can introduce blending and anatomy errors.
- Never rely on positional ordering when the API supports explicit reference roles or tags.
- Record hashes and immutable source paths before upload.

Inside a `$produce-short-video` project, references arrive through `node src/cli.mjs assets add`
and must clear `node src/cli.mjs assets check --model kling-o3 --mode <mode>` before submission.
That check reports the per-mode image budget, which is smaller for `reference_to_video` and
`video_edit` than for `image_to_video`.

## Write the prompt

State global continuity once, then describe a short causal sequence. Bind references by their provider-supported tags. Use concrete camera and action language, exact quoted dialogue when supported, and a clear end state.

For timed controls, keep each interval achievable and leave edit handles. Do not claim frame accuracy unless the provider documents it and QA confirms it. If the task combines identity, motion, scene replacement, dialogue, native audio, and several camera cuts, split it or simplify references before spending credits.

## Submit safely

Create a normalized request and the exact provider payload. Include resolved capabilities, reference-role mapping, input hashes, requested output, cost estimate, and idempotency key.

When execution is authorized:

1. preflight URLs, MIME types, durations, policy, and incompatible fields;
2. persist the immutable request;
3. submit once and store the raw response/task ID;
4. poll the existing task with bounded backoff;
5. preserve all outputs, including failed or partial takes;
6. log provider moderation or validation errors verbatim with secrets redacted.

Never interpret a polling timeout as proof that submission failed.

## Handoff

Return the exact resolved model identity, capability snapshot, reference-role map, normalized intent, redacted payload, task status, output paths, and deviations. Invoke `$review-generated-video` and pay special attention to reference leakage/blending, identity across cuts, motion-transfer fidelity, audio synchronization, and transformed-video artifacts.

## Reference

- [Kling O3/Omni naming and provider contract](references/provider-notes.md)
