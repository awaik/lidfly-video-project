# Edit manifest and delivery contract

The cut is described by a manifest and executed by `node src/cli.mjs assemble`. This document
describes the manifest the assembler actually accepts: an unknown field is rejected, so a shape
copied from elsewhere fails validation rather than being half-honoured.

## Manifest

```jsonc
{
  "schema_version": 1,
  "project_id": "ACME-V001",
  "variant_id": "E001",

  "output": {
    "width": 1080,
    "height": 1920,
    "frame_rate": 24,
    "audio_sample_rate": 48000,
    "fit": "pad",
    "masters_root": "artifacts/acme/V001/masters"
  },

  "segments": [
    {
      "id": "seg1",
      "kind": "clip",                  // clip | still | still_sequence
      "source": "artifacts/.../outputs/result-01.mp4",
      "frames": 96,                    // output frames, always; never seconds
      "in_seconds": 0.125,
      "speed": 0.6218,                 // or { "factor": 0.6218, "interpolation": "none" }
      "audio": "source",               // source | silent (graphics are always silent)
      "review": "projects/.../reviews/S001-T001.review.json",
      "motion": { "type": "none" },    // none | scroll (to_y) | zoom_in (amount)
      "overlays": [
        {
          "asset": "projects/.../graphics/cap-run.png",
          "x": 0,
          "y": 250,
          "from_seconds": 0.35,
          "to_seconds": 2.05,
          "subject_checked_at_seconds": [0.35, 1.2, 2.05],
          "subject_clear": true,
          "note": "верх кадра — небо; голова героя ниже 540px"
        }
      ]
    }
  ],

  "audio": {
    "music": {
      "source": "audio/bed.wav",
      "gain": 1,
      "fade_out_from_seconds": 27,
      "fade_out_seconds": 2,
      "rights": "licensed"             // licensed | synthesized_placeholder
    },
    "voiceover": {                     // optional: separately produced voice (TTS / VO)
      "rights": "synthesized_tts",     // synthesized_tts | recorded_licensed
      "provenance": "projects/.../audio/voiceover-B2.json",
      "cues": [
        { "id": "L1", "source": "artifacts/.../L1.wav", "at_seconds": 0.1, "duration_seconds": 3.77 }
      ]
    },
    "native": { "role": "effects", "gain": 1.5, "duck_level": 0.35 }, // optional; default role is speech
    "speech": { "normalize_lufs": -17, "gain": 1 },
    "ducking": { "level": 0.16, "ramp_seconds": 0.4 },
    "limit": 0.84,
    "target_lufs": [-20, -16]
  },

  "notes": ["720 кадров при 24 fps = ровно 30.000 сек"]
}
```

### How the timeline is derived

Positions are never authored. Frame counts accumulate in order, and everything else follows:
`start_frame`, `total_frames`, `start_seconds` and `duration_seconds` per segment, plus
`total_frames` and `total_seconds` for the master. A hand-written start time that disagrees with the
frame counts is a defect waiting to happen, so the schema does not accept one.

Durations are frame counts because seconds round: a nominal `-t 1.6` at 24 fps silently becomes 38
frames and shifts the whole tail of the cut.

### Retiming

`speed` is only valid on a `clip`. `frames` still means output frames; the factor decides how much
source is consumed: `source_seconds = frames / frame_rate * factor`. Picture and sound are retimed
together — `setpts` on the video, a chained `atempo` on the audio, then padded and trimmed to the
exact segment length, because concat accumulates millisecond drift across segments.

`interpolation` is `none` by default. `blend` and `motion` cost minutes of CPU per segment and warp
fast movement, so they are a deliberate choice, reviewed visually.

### Speech windows

Every `clip` segment with `audio: "source"` becomes a speech window. Music is ducked under those
windows by an explicit curve derived from the cut, and the source audio is normalized on its own —
running `loudnorm` over the finished mix would undo the ducking.

### Separate voiceover

`audio.voiceover.cues` places each line of a separately produced voice on the timeline by
`at_seconds`. A cue may run across a cut; its window merges with neighbouring speech. The cue files
stay untouched: assembly delays each one, mixes them into one voice bus, normalizes that bus on its
own with `audio.speech`, and ducks the music under the cue windows. `duration_seconds` is declared so
the windows stay a pure function of the manifest; assembly probes every cue file and refuses to
encode when the file disagrees by more than 0.05 s. A cue that ends after the timeline is rejected.
Use this instead of muxing voice into per-shot intermediates.

### Native audio as effects

Without `audio.native`, a clip's own soundtrack is dialogue: it claims a speech window, ducks the
music and is normalized to `audio.speech`. When the model's sound is effects under a separate
voiceover (a meow, a yawn, a keyboard), declare `"native": { "role": "effects" }`. Those clips then
claim no speech window, keep the relative level the model gave them (no loudnorm, which would lift a
quiet take's room tone to dialogue loudness), are scaled by `gain`, and duck to `duck_level` under
the voiceover cue windows. Music ducks only under the voiceover.

## Validation rules

- Every source, overlay asset and music file exists; a missing input fails before any encoding.
- Segment ids are unique, so intermediates cannot collide.
- `review` on a clip is either a path to a review record (ending in `.json`) or a free note. A path
  must resolve, parse, and carry an accepting `decision`; a rejected take blocks the master.
- Overlay `subject_checked_at_seconds` must sit inside the overlay's window and increase.
  `subject_clear: false` blocks the master — a declared collision must not ship.
- Music declares its rights. A synthesized bed is legitimate, but never called licensed.
- `target_lufs` is an ordered `[floor, ceiling]` pair, and the finished master is measured against it.
- The output path is new: every run writes the next `-master-vN.mp4` and never overwrites one.

## What assembly does not do

- No burnt-in SRT: captions are overlay images with explicit positions.
- No transitions: cuts only. A cross-dissolve belongs to a segment you rendered yourself.
- No colour grading.
- No uploading. Rendering a master does not publish it.

## Aspect ratio and `fit`

`output.width`/`output.height` define the delivery shape; nothing derives it from the sources.
Any ratio works — 1080x1920, 1920x1080, 1080x1080 — as long as every source agrees with it.

When a source does not agree, assembly refuses to build until the manifest says what to do,
because the silent answer used to be a stretch and a stretched face is not something a review
catches from a filename. Declare `fit` on `output`, or per segment to override it:

| `fit` | ffmpeg | Result |
|---|---|---|
| `pad` | `force_original_aspect_ratio=decrease` + `pad` | Letterbox or pillarbox. Nothing is lost, bars are added. |
| `cover` | `force_original_aspect_ratio=increase` + `crop` | Fills the frame. Edges are cropped away. |
| `stretch` | plain `scale` | Distorts. The old implicit behaviour, now something you say out loud. |

Sources that already match the output need no `fit` at all — upscaling 720x1280 to 1080x1920 is
the same shape and passes untouched. A `still` segment with `motion.type: "scroll"` is exempt:
it is fed an over-tall image on purpose and crops a moving window out of it.

If the masters root sits under `artifacts/<client>/V<NNN>/masters`, assembly also compares the
output shape and frame rate against that project's frozen `brief/shotplan.json` and reports a
disagreement — a warning normally, a blocker under `--require-review`.

## Delivery verification record

`assemble` writes `<variant>-master-<version>.report.json` next to the master. It records measured
numbers, not pass/fail labels:

```jsonc
{
  "variant_id": "E001",
  "master_path": ".../E001-master-v1.mp4",
  "master_sha256": "...",
  "version": "v1",
  "reused": false,
  "inputs_fingerprint": {              // manifest + assembler revision + every input file
    "algorithm": "sha256",
    "assembler_revision": 2,
    "manifest_sha256": "...",
    "files": [{ "path": "...", "sha256": "..." }],
    "fingerprint": "..."
  },
  "segments": [
    { "id": "seg4", "kind": "clip", "start_seconds": 11.75, "frames": 152,
      "speed": 0.6218, "interpolation": "none", "source_seconds": 3.938,
      "review": { "kind": "path", "value": "projects/.../S004-T001.review.json" } }
  ],
  "reviews": [
    { "segment_id": "seg1", "status": "accepted", "decision": "accept",
      "source_matches_review": true, "cut_seconds": [0, 4], "usable_range_seconds": [0, 4] }
  ],
  "overlay_clearance": [
    { "segment_id": "seg3", "overlay_index": 0, "window_seconds": [0.35, 2.05],
      "checked_at_seconds": [0.35, 1.2, 2.05], "subject_clear": true }
  ],
  "verification": {
    "duration_seconds": 30.02, "frames": 720,
    "video": { "codec": "h264", "width": 1080, "height": 1920, "frame_rate": 24 },
    "audio": { "codec": "aac", "sample_rate": 48000, "channels": 2 },
    "loudness": { "integrated_lufs": -17.02, "true_peak_dbtp": -1.87, "lra": 14.9 },
    "phase_levels": [{ "id": "seg1", "mean_db": -17.4, "max_db": -2 }],
    "black_stretches": [], "frozen_stretches": [], "frozen_in_footage": [],
    "issues": [], "warnings": [], "status": "ok"
  }
}
```

The fingerprint is what makes a rerun free: an unchanged manifest with unchanged inputs returns this
report instead of re-encoding the timeline. `assembler_revision` is part of it, so a change to the
encoder arguments or the filter graph invalidates the cache rather than serving a master built by
older code.

## Delivery settings

For YouTube Shorts and Reels: MP4, H.264 progressive, source frame rate, AAC-LC at 48 kHz, BT.709
SDR, native to the delivery ratio without baked black bars. Record whether the content needs the platform's
altered/synthetic-content disclosure. Rendering a master never authorizes uploading it.
