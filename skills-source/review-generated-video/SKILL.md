---
name: review-generated-video
description: "Review and compare AI-generated video takes before editing or delivery. Use after Kling, Seedance, or another video model completes a job to detect technical failures, identity drift, continuity errors, anatomy or physics problems, lip-sync and audio defects, policy risks, and weak edit handles, then choose, trim, reroute, or regenerate without deleting source media."
---

# Review Generated Video

Make a traceable accept, conditional-accept, or reject decision for every generated take. Review against the approved shot intent and references, not against visual spectacle alone.

## Inputs

Collect:

- immutable generation request and raw provider metadata;
- every candidate output for the `shot_id`;
- storyboard panel, continuity bible, script/dialogue, and reference assets;
- intended edit in/out points and delivery profile;
- known platform disclosure and rights requirements.

If an expected artifact is absent, record the gap. Never infer provider parameters from the video file alone.

## Review sequence

### 1. Verify provenance and technical integrity

Confirm file hash, source task ID, model/provider ID, duration, dimensions, aspect ratio, codec, frame rate, audio streams, decode success, and missing/frozen/duplicate frames. Preserve the original file; review a derivative only when necessary.

### 2. Inspect temporal behavior

Read the [visual storytelling standard](../develop-shot-plan/references/visual-storytelling.md) for the applicable camera, rhythm and comparison requirements. Compare the first and last usable frames: a change in expression alone does not prove the ordered action. Check that a meaningful transformation happens during the shot and that speech precedes text when the beat promises voice-driven writing. Compare accepted before/after takes side by side for camera line and shot size; identical prompt wording is insufficient.

Watch the full take at normal speed with sound, once without sound, and again around cuts, contact events, dialogue, and the final state. Inspect representative frames and scene boundaries; a good first frame does not prove a good clip.

### 3. Apply hard gates

For required speech or a proposed replacement, read [speech verification and audio production](../assemble-short-video/references/audio-production.md). `verify-speech` needs `KOMEND_ASR_ENDPOINT`; without it, ASR has not occurred. `detect-speech` cannot establish native_audio_status or open the TTS gate. Manual status is an explicit, recorded override. A replacement that changes lip sync needs the user's decision and `audio_disposition` in every affected review.

Reject the take when it contains:

- unsafe, disallowed, or rights-conflicting output;
- wrong person/product or severe identity/reference leakage;
- unusable anatomy, object topology, contact, or physical causality;
- an unplanned jump, morph, camera break, or missing core action;
- keeping unintelligible required dialogue or materially wrong spoken words in the final audio (verify with
  `node src/cli.mjs verify-speech --job <directory>`, which transcribes the take and compares it
  with the scripted line rather than leaving the judgement to an unaided listen);
- corrupt media or no usable edit interval.

Do not average a hard failure into a passing score. A take with `missing`/`unusable` speech is not accepted with that native audio. Its otherwise passing picture may be accepted with a specific approved replacement, recorded `audio_disposition`, and verified replacement words, timing and lip-sync trade-off. Until the repair and its checks are complete, do not mark the take ready for final assembly.

### 4. Score surviving takes

Use [references/qa-rubric.md](references/qa-rubric.md). Score evidence, continuity, motion/physics, camera/composition, temporal stability, audio/dialogue, and editability. Add shot-specific criteria from the manifest.

### 5. Choose the cheapest valid correction

- **Accept:** meets hard gates and intended edit.
- **Accept with trim/post:** the usable range is clear and the defect is deterministic to fix in editing.
- **Composite:** two accepted segments can be combined without concealing a rights/policy problem.
- **Regenerate:** change one major variable and state why.
- **Reroute:** another model or non-generative edit better matches the unmet control.

Never delete rejected takes. Mark status and keep the reason.

## Comparison rules

- Compare candidates blind to model/provider when practical; reveal cost/model only after quality scoring.
- Prefer the take that serves the story and cut, not the take with the most motion.
- Treat native model audio as a draft until speech, sync, noise, and music rights pass review.
- Treat exact generated text, logos and labels as unreliable; correct them with overlays on model footage. Do not replace a filmed screen or standalone shot with drawn UI.
- A higher-resolution take does not outrank a more coherent lower-resolution take automatically.
- Never claim a model is categorically better from one shot. Record the shot type and failure mode.

Record any accepted difference from the ordered plan in `observed_deviation` in the take review; bind that review in the edit manifest. Never rewrite the frozen script or plan to describe what the model happened to render. Keep review notes at most 600 characters; beat verdicts use `pass` or `fail`.

## Handoff

Return a compact decision table with:

- `shot_id`, `take_id`, hash, model/provider, and usable time range;
- hard-gate result and evidence timestamps;
- rubric scores and total;
- decision: accept, trim/post, composite, regenerate, or reroute;
- exact correction and the single major variable to change;
- selected edit in/out points and audio disposition;
- disclosure or human-review flags.

## Reference

- [Video-generation QA rubric](references/qa-rubric.md)
