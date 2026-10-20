---
name: assemble-short-video
description: "Assemble reviewed AI-generated takes into a reproducible short-form master in any delivery ratio with programmatic editing or a configured rendering API. Use when accepted Kling, Seedance, or other clips must be trimmed, composited, captioned, branded with exact logos or text, mixed with approved voice/music/SFX, encoded for YouTube Shorts or Reels, and verified without manual editing."
---

# Assemble Short Video

Turn reviewed takes and deterministic brand/audio assets into an edit master through a declared renderer. Preserve source media and make the same manifest produce the same timeline whenever the renderer is deterministic.

## Entry contract

Require:

- project and shot/take manifests with `$review-generated-video` decisions;
- selected in/out ranges and intended timeline order;
- exact script, captions, CTA, logo, product text, fonts, and safe-area rules;
- for every shot that pans, pushes in, or otherwise changes framing, the range of subject/face positions across that shot, not only its first frame;
- approved VO, music, ambience, and SFX plus rights status;
- output platforms, aspect ratio, duration target, language, and disclosure decision;
- configured renderer: local programmatic toolchain or remote editing/rendering API;
- execution authority and budget when the renderer is paid.

Never accept an unreviewed take as a final timeline source. If a brand asset or spoken claim is missing, stop or use an explicitly labeled placeholder in a draft only.

## Non-destructive rules

- Read generated originals; write proxies, intermediates, and masters to new paths.
- Never trim, normalize, transcode, rename, or overwrite the only source copy.
- Keep exact logos, UI, prices, claims, captions, and CTA as deterministic overlay assets rather than regenerated pixels.
- Preserve generated audio as a source stream even when muting or replacing it in the edit.
- Do not publish or upload merely because a master was rendered.
- Do not silently change timing, crop, frame rate, language, music, renderer, or output profile.

## Workflow

### 0. Use the project's assembly workflow

Read [the finishing standard](references/finishing-standard.md) before preparing the manifest or graphics. Every standalone frame is model footage; exact UI/text/branding may be overlaid on it, never used as a replacement slide.

This repository ships a deterministic assembler: describe the cut as an edit manifest and run

```bash
node src/cli.mjs assemble --manifest projects/<client>/VNNN/edits/<variant>.edit.json --require-review
```

It builds the segments, mixes, verifies, versions the master without overwriting, and writes a
report of measured numbers next to it. Rerunning an unchanged manifest returns the master it already
built instead of re-encoding it; `--force` rebuilds. Retiming lives in the manifest as `speed` on a
clip segment, so a slowed shot stays reproducible from the manifest instead of becoming a hand-made
file in a side directory. `--require-review` turns a missing or unreadable take review into a
blocker; without it those are warnings, because two existing projects predate the rule. Four constraints are already encoded there, each of which
previously cost a rebuild: segment lengths are declared in frames (a nominal `-t 1.6` at 24 fps
silently becomes 38 frames), every segment carries an audio track so concat stays aligned,
`alimiter` runs with `level=disabled` because its default auto-level pushes peaks back to the
ceiling, and speech is normalized on its own instead of running `loudnorm` over the finished mix,
which would undo the ducking.

Check `node src/cli.mjs doctor` before building graphics: it reports whether the local rasterizer
honours SVG `stroke` and which fonts carry Cyrillic and the ruble sign.

If the manifest cannot express the cut, prepare a concrete extension or seek a decision on another route. Do not silently replace the assembler with an ad-hoc script.

The project's second, interactive route is OpenChatCut (`$edit-with-openchatcut`): transitions,
keyframes, motion graphics, styled captions, effects and colour that the manifest does not model,
or any edit the user wants to review inside an editor. Its export re-enters the project only
through `node src/cli.mjs adopt-master`, which versions it under the same masters root, records
its origin and measures it against the frozen plan; steps 5 and 6 below apply to an adopted
master unchanged.

### 1. Resolve the renderer

Record renderer name, version or API model/revision, capabilities, output codecs, font handling, transition support, audio filters, idempotency, async states, price, and retention. Prefer a local deterministic renderer when it satisfies the job; use a remote API when its feature or scale is required and authorized. For OpenChatCut, `node src/cli.mjs openchatcut status` reports the checkout version and the skill baseline the server announces; record both.

If the selected renderer cannot reproduce exact layout, timing, alpha, font, or color requirements, stop and report the mismatch. Never replace exact artwork with model-generated approximations.

### 2. Build the edit decision list

Read [references/edit-manifest.md](references/edit-manifest.md). For every timeline item, bind an immutable source hash, in/out range, timeline start, crop/scale policy, transition, audio disposition, and review ID.

Use cutaways to cover approved dialogue or lip-sync repairs. Keep generated shots short enough to remove weak heads and tails. Allocate explicit handles; do not stretch clips merely to fill the target duration.

### 3. Compose graphics and captions

- Use the supplied logo/vector/raster asset without redrawing it.
- Keep captions and critical CTA inside project safe areas.
- Create captions from the approved script or verified transcript, then review timing and spelling.
- Record font files, fallbacks, layout dimensions, colors, opacity, and animation timing.
- Treat product facts, prices, comparisons, and legal copy as fact-check inputs, not creative filler.

A safe area measured from the canvas edges is not sufficient by itself: it says nothing about where the
subject is at that moment. Before locking a caption or graphic position:

- Sample frames across the full timeline segment the overlay covers (start, middle, end; sample more
  densely for a shot that pans, pushes in, or zooms) and confirm the overlay does not sit on a face, eyes,
  or the shot's primary action at any sampled moment, not only the frame used to pick the position.
  Record those timestamps in the overlay as `subject_checked_at_seconds`, and the verdict as
  `subject_clear`. A declared collision (`subject_clear: false`) blocks the master.
- When one fixed position cannot stay clear for the whole segment, do one of: shorten the overlay's time
  window to the portion that stays clear, split it into separately positioned segments, or choose the
  position that stays clear at the shot's tightest framing, where a collision is most likely.
- Record which frames were checked (timestamps) alongside the layout in the edit manifest so the check is
  reproducible, not just asserted.

### 4. Build the sound mix

Read [speech verification and audio production](references/audio-production.md) before TTS or replacing native audio. Reuse existing permissions, preserve the native source, and record the user's lip-sync replacement decision in each affected take's `audio_disposition`.

Declare each stream as production dialogue, replacement VO, generated audio, music, ambience, or SFX. Record source rights and gain automation. Replace broken native audio only when the creative plan permits it; do not conceal a materially wrong spoken claim with music.

Prefer a licensed or library music track over synthesizing one from primitive oscillators/noise. Raw
synthesis has a low ceiling on how produced or rich it can sound. Only fall back to synthesis when no
licensed source is available or approved, and label the result explicitly as a placeholder to the user with
a recommendation to swap in a real track.

Keep dialogue intelligible, avoid clipping, use short fades at edits, and measure the final mix with the
renderer's available tools. Measuring "not clipping" is not sufficient by itself — also confirm the mix is
not too quiet to hear:

- Measure integrated loudness (e.g., an LUFS meter, or `ffmpeg -af loudnorm=print_format=json` /
  `volumedetect` as a fallback) and target roughly -16 to -20 LUFS integrated for a social/mobile delivery
  unless the project states another target.
- For any background bed under dialogue, isolate a dialogue-silent stretch (or the bed's own pre-mix
  source) and measure it independently — a bed that only "shows up" in a whole-file average dominated by
  louder dialogue can still be inaudible on its own. State the isolated measurement, not just the whole-mix
  average.
- Record the actual measured numbers (not just "measured" or "passed") in the delivery verification record.

Store both the mix and stem provenance.

### 5. Render draft, then master

1. save the immutable edit manifest and asset hashes;
2. render a fast draft with burn-in IDs or timecode when useful;
3. review order, crop, overlays, captions, dialogue, and duration;
4. revise the manifest rather than hand-editing the output;
5. render the delivery master to a new path;
6. save renderer command/request, redacted response, logs, hashes, and technical metadata.

For a remote async renderer, persist the task ID before polling and never resubmit solely because status retrieval failed.

### 6. Verify delivery

Run `node scripts/analyse-master.mjs <master> <manifest>` and retain its segment-level motion, shot-size and rhythm findings with the delivery record. Resolve or explicitly record outstanding findings; a contact sheet is insufficient.

Decode the complete master and confirm duration, dimensions, aspect ratio, frame rate, color, audio streams, caption spelling/timing, logo fidelity, black frames, frozen frames, and absence of unintended letterboxing.

Also confirm, with recorded evidence rather than a bare pass/fail label:

- captions and graphics stay clear of the subject's face across every sampled moment of their segment (see
  step 3), including in the finished master, not only in the source overlay asset;
- measured loudness (integrated LUFS or the fallback dB reading) meets the declared target from step 4,
  checked on the finished master, not only on the pre-mix stems.

For YouTube, prefer the current official upload guidance: MP4, H.264 progressive video, source frame rate, AAC-LC or Opus at 48 kHz, and BT.709 for SDR unless the target requires another supported profile. Files should remain native to their delivery ratio rather than include baked black bars.

Record whether realistic generated or meaningfully altered content requires YouTube's AI-use disclosure. Rendering a master does not authorize uploading it.

## Handoff

Return:

- renderer/capability snapshot and approval boundary;
- immutable edit manifest and source hashes;
- draft and master paths with hashes;
- exact command or redacted API request/job record;
- technical verification and any remaining human-review flags, including the measured loudness numbers and
  the caption/graphic-vs-subject clearance check from step 6, not just pass/fail labels;
- caption, audio-rights, graphics, and synthetic-content disclosure status;
- upload-ready settings without publishing unless separately requested.

## Reference

- [Edit manifest and delivery contract](references/edit-manifest.md)
