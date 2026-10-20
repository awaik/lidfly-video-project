# Shot plan and continuity contract

Two documents live in `projects/<client>/V<NNN>/brief/`. Both are validated: an unknown field is an error, not a note in the margin.

## `shotplan.json`

```jsonc
{
  "schema_version": 1,
  "project_id": "ACME-V001",

  // The envelope: what happened TO the plan. Excluded from the plan hash, so
  // freezing does not invalidate the hash it stamps.
  "status": "frozen",                 // draft | reviewed | frozen
  "plan_hash": "<sha256>",
  "continuity_hash": "<sha256>",
  "frozen_at": "2026-08-17T10:00:00.000Z",
  "check_snapshot": { "ok": true, "blockers": 0, "warnings": 2, "checked_at": "..." },
  "review": { "record": "reviews/shotplan-<hash12>-R2.json", "reviewer_pass": 2,
              "plan_hash": "<sha256>", "verdict": "approve" },

  "source_script": { "path": "brief/source-script.md", "sha256": "<sha256>", "title": "..." },
  "target": {
    "duration_seconds_total": 30,
    "duration_tolerance_seconds": 0.5,
    "aspect_ratio": "9:16",
    "frame_rate": 24,
    "model_default": "seedance-2.5",
    "resolution_default": "720p",
    "audio_mode": "native_audio_plus_titles",
    "generate_audio": true            // optional; false keeps model audio out of every composed request
  },

  "beats": [
    { "beat_id": "B07", "label": "Обрушение моста", "script_time": "0:21-0:24",
      "kind": "climax", "importance": "climax", "purpose": "пик действия" }
  ],

  "shots": [
    {
      "shot_id": "S005",
      "beat_ids": ["B07"],
      "source": "generated",          // generated | graphics | stock | reused_take
      "edit_purpose": "кульминация действия",
      "duration_seconds": 4,          // what the provider renders
      "timeline_seconds": 4,          // what the cut occupies, after any retime
      "shot_size": "wide",
      "camera": "быстрая проводка за обрушением пролёта",
      "subject": ["hero", "hound"],
      "start_state": "Герой у арки, зверь на перилах",
      "end_state": "Пролёт сложился",
      "events": [
        { "event_id": "E1", "text": "the bridge folds and drops into the black water",
          "window_seconds": [0, 4], "reads_as": "секции пролёта падают одна за другой" }
      ],
      "continuity_keys": ["light.copper_evening", "location.footbridge", "scale.hound"],
      "identity_refs": ["hero-body", "hound-guardian"],
      "route": { "model": "seedance-2.5", "mode": "reference_to_video", "reason": "...", "fallback": "..." },
      "style_note": "медный контровой свет по кромке пролёта",
      "dialogue": null,
      "audio_intent": ["metal_crash", "stone_impact"],
      "risk": ["dense_action_physics"],
      "location_change": false,
      "time_jump": false,
      "continue_from": null           // start this shot from the last frame of another
    }
  ]
}
```

Three fields carry most of the weight:

- **`beat_ids`** makes coverage a set difference instead of an opinion.
- **`events`** makes density countable. There is no `prompt` field, so an extra action cannot arrive as prose.
- **`timeline_seconds`** separates what is generated from what the cut occupies. Four seconds of generation became 6.33 seconds of timeline at 0.62× in the trailer this schema came from.

`target.generate_audio` is optional. When the soundtrack is produced separately (voiceover, music added in the edit), set it to `false`: `compose` writes it into every request and the gate refuses a request that turns model audio back on. Left out, compose keeps the provider default and the gate does not bind it.

`location_change` and `time_jump` declare actual transitions. `importance: "optional"` is a scope choice, not a way for the agent to silence a blocker: changing a required/climax beat to optional requires the user's decision before freeze. These declarations live in the file the reviewer reads, never on the command line. Preserve the approval alongside the brief and make the approved scope clear in the source material before freezing; do not add unsupported approval fields to this schema.

The schema also admits legacy/non-generated source types; in this project, that does not authorize a standalone graphics frame. Local graphics must remain overlays on model footage.

`target.aspect_ratio` is the delivery shape and `9:16` above is only this example's value: any ratio
the routed models accept works — `16:9`, `1:1`, `4:3`, `3:4`, `21:9`. `script check` refuses a ratio
the plan's own routes cannot render, and warns when a route takes its orientation from a start frame
instead of from the target, so an impossible target cannot survive to freeze. Set it once, at
`script init --aspect-ratio`, and keep the edit manifest's `output.width`/`output.height` on the
same shape.

## `continuity.json`

```jsonc
{
  "schema_version": 1,
  "project_id": "ACME-V001",
  "global_prompt_block": "Realistic anime, high-end Chinese donghua cinematic rendering, vertical 9:16.",
  "negative_prompt_block": "No text, no subtitles, no on-screen letters, no watermark.",
  "required_anchor_kinds": ["light", "location"],

  "anchors": {
    "light.copper_evening": { "kind": "light", "text": "Copper evening light from above, cold blue shadow below." },
    "location.footbridge":  { "kind": "location", "text": "ONE narrow rusted iron-grating footbridge between a half-ruined house and a stone tower arch." },
    "scale.hound":          { "kind": "scale", "text": "The guardian's back reaches the boy's chest and never higher." }
  },

  "entities": {
    "hero": {
      "kind": "character", "role": "protagonist",
      "prompt_text": "Alex, a teenage boy about fifteen, messy dark hair, pale cold skin",
      "invariants": ["dark coat with raised collar", "torn hem"],
      "signature_feature": "тёмное пальто с поднятым воротником",
      "requires_close_up": true,
      "identity_assets": ["hero-face", "hero-body"],
      "scale_anchor": null
    }
  }
}
```

Anchor ids are `kind.name` and the prefix must match the declared kind. Anchor kinds: `light`, `location`, `scale`, `palette`, `wardrobe`, `prop`, `weather`, `screen_direction`.

## How a prompt is assembled

`script compose` builds each prompt in a fixed order, and `--dry-run` prints the blocks:

`style` → `world` (location, palette, weather, prop, screen direction anchors) → `light` → `entities` with their invariants → `scale` → `framing` (shot size, camera, start state) → `events` as `a-bs: …` → `audio` → `note` → `negative`.

Windows come from `window_seconds` when declared, otherwise the shot's duration is split evenly, so the model always receives an order and a pace.

## Findings

`{ level, code, shot_id | beat_id, message }`, exactly like `assets check`. `ok` is true when there are no blockers, and the CLI exits 1 when it is false.

Blockers: `beat_not_covered`, `shot_without_beat`, `shot_without_event`, `shot_event_overload`, `climax_not_isolated`, `style_note_contains_timeline`, `missing_required_anchor_kind`, `neighbor_location_anchor_mismatch`, `light_anchor_flapping`, `scale_anchor_missing`, `identity_without_reference`, `identity_reference_in_unsupported_mode`, `protagonist_never_close`, `duration_total_mismatch`, `duration_below_provider_minimum`, `route_unbuildable`, `unknown_anchor`, `unknown_entity`, `unknown_beat_reference`, `unknown_identity_asset`, `plan_project_mismatch`, `continuity_project_mismatch`, `plan_has_no_beats`, `plan_has_no_shots`, `event_window_invalid`.

Warnings: `anchor_never_used`, `beat_split_across_shots`, `event_window_short`, `event_text_compound`, `location_change_unexplained`, `first_appearance_no_reference`, `shot_size_monotony`, `retime_ratio_extreme`, `cost_unknown_rate`, `dialogue_too_dense`.

## The gate

`plan` and `submit` refuse a project-bound job unless: the plan exists, its status is `frozen`, its hash matches its contents, the continuity hash matches, the request carries `metadata.script.plan_hash` equal to that hash, the shot is in the plan, and the request's duration, model and mode match what was reviewed.

An ad-hoc job with no `metadata.production` is not covered — the same boundary the budget gate uses.

For a project shot before the gate existed, `approval.script_plan_waiver` in `project.json` exempts named shots:

```json
"script_plan_waiver": {
  "reason": "Отснято 2026-08-14 до появления гейта",
  "waived_by": "producer",
  "waived_at": "2026-08-17T09:00:00.000Z",
  "shot_ids": ["S102", "S103"]
}
```

It is never created by the bootstrap, so its absence means the gate applies. It names shots one by one, it covers only this gate, and it is recorded in the job journal like any other decision.
