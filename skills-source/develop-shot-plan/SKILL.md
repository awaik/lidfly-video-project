---
name: develop-shot-plan
description: "Turn a script or brief into a machine-checked, independently reviewed, frozen shot plan before any paid video generation. Use when a project needs beats mapped to shots, continuity anchors locked, and prompts composed from the plan rather than written by hand, so a scene cannot lose its climax, its protagonist, or its geography inside a four-second shot."
---

# Develop Shot Plan

Decide what each paid second of footage has to accomplish, prove it survives an independent read, and freeze that decision before a single request is submitted.

## Why this exists

A finished 30-second trailer in this repository lost its climax. Four events were written into one four-second shot: the guardian hits the rail, the pin tears out, the bridge folds, the boy jumps. The model rendered the first and the last. The take was reviewed afterwards and accepted, because the take was fine — the plan was not. The same run dropped the beat where the hero sees the solution, so the protagonist never appears in close-up and his one distinguishing feature is never legible.

Reviewing a take cannot catch either failure. Both are decided before the request is sent.

## Non-negotiable rules

- One shot renders at most `floor(duration/2)` events, never more than three, and a climax beat gets a shot to itself.
- Every required or climax beat gets a shot. If it cannot fit the budget or duration, prepare concrete alternatives; downgrading it to `optional` or removing it requires the user's decision before freeze. A checker suggestion is not authorization to reduce scope.
- The reviewer subagent receives exactly three inputs: the source script, `shotplan.json` plus `continuity.json`, and the `script check` output. It never receives the director's rationale, and it never edits the plan.
- There is no override flag. For new plans, `plan` and `submit` refuse until check → review → freeze completes. An existing named `approval.script_plan_waiver` only covers its specific already-shot legacy `shot_ids`; bootstrap does not create it. Do not require a replacement plan solely to resume those covered shots.
- Declarations (`location_change`, `time_jump`, and user-approved scope changes to `importance: optional`) live inside the reviewed plan, never on the command line. Record the user's scope decision alongside the brief; do not invent fields in the schema.
- A shot has no prompt field. Prompts are composed from the plan and the continuity anchors, so an extra action cannot be smuggled in as prose.
- Machine blockers are not the reviewer's to clear: `freeze` recounts them itself.
- Never edit a frozen plan or its source script in place, even for a typo or path change. Document renames separately; accepted take deviations belong in the take review, not in the ordered plan.

## Three passes

### Pass 1 — the director writes the plan

Read [the visual storytelling standard](references/visual-storytelling.md) and the source script whole before splitting it. For start-frame inheritance or route failures, also read [runtime constraints](references/runtime-constraints.md). Then produce, in this order: the beat list, the shot list that covers it, and the continuity anchors both depend on. Write `continuity.json` before the shots, not after — anchors are what the shots refer to.

Spend the duration budget deliberately. A beat that carries the turn or the climax deserves its own shot; two beats of pure setup can share one. Give the protagonist at least one close-up somewhere: an audience that never sees a face remembers a world, not a character.

### Pass 2 — an independent reviewer reads it

Run `script check` first, so the machine findings exist. Then hand a **separate subagent** the source script, the two plan documents, and the check output — and nothing else. No routing rationale, no risk notes, no explanation of why a shot is the way it is. The reviewer answers the questions in [the review rubric](references/shotplan-review-rubric.md) and writes a review record.

The reviewer's job is not to agree. It is to name the shot that will not render in its own duration, the beat that has quietly disappeared, the place where the audience will misread what happened, and the moment where the world changes without anyone declaring it.

### Pass 3 — revision and polish

Answer every finding: accept it and change the plan, or reject it and record why. Re-run `script check`. When the reviewer approves a plan whose hash matches what it read, freeze it and compose the requests.

## Workflow

### 0. Resolve the project

The plan belongs to a production context created by `scripts/init-production.mjs`. Do not start a plan for a project that does not exist yet.

### 1. Create the plan and its continuity

```bash
node src/cli.mjs script init --project projects/<client>/V<NNN> \
  --script <path to the source script> --duration-seconds 30 \
  --title "<name>" --aspect-ratio <approved-ratio> --audio-mode native_audio_plus_titles
```

Resolve the ratio from the user or approved brief before this command; do not accept an implicit 9:16 default. This records the script's sha256, so a plan can never quietly refer to a script that has changed since. For a project that predates the gate, `--adopt` recovers the shots from existing requests; beats, events and anchors stay empty, because prose cannot be parsed back into them.

### 2. Decompose the script into beats

One beat is one thing the audience learns or feels. Mark each `required`, `climax`, or `optional`, and say what it is for. Ten beats in thirty seconds is normal; what is not normal is discovering later that six of them never got a shot.

### 3. Map beats to shots

For every shot, state its events explicitly. An event is something that changes on screen and can be seen changing. "The guardian steps onto the grating" is an event; "tension rises" is not.

Split anything that reads as a chain. If the beat is the climax, it gets its own shot with one event.

### 4. Write the continuity anchors

Anchor ids are `kind.name` — `light.copper_evening`, `location.footbridge`, `scale.hound`. Every generated shot carries the anchor kinds the project declares required, which is how a trailer stops flickering between evening and midday. An entity whose size matters gets a `scale_anchor`, and any shot it appears in must carry it.

Give the protagonist `requires_close_up: true` and a `signature_feature`. Both turn into a refusal if the plan never shows them.

### 5. Run the machine checks

```bash
node src/cli.mjs script check --project projects/<client>/V<NNN>
```

Blockers stop the freeze; warnings are for the reviewer to weigh. Fix blockers by splitting or lengthening shots, correcting routes, or declaring genuine continuity changes. If a diagnostic suggests downgrading a beat, obtain the user's scope decision first; the suggestion cannot grant it.

### 6. Commission the independent review

Spawn a separate subagent with the three inputs named above and the rubric. Save its record and register it:

```bash
node src/cli.mjs script review --project projects/<client>/V<NNN> --record <review.json>
```

A record written against an older version of the plan is refused: the reviewer must have read what is actually on disk.

For Gemini browser shots, set `route.model: "gemini-browser"` before freeze and use `$generate-browser-video` for UI capability checks. `browser_preflight_required` means the CLI cannot certify the website's current model, controls or quota. Record the observed settings in the brief for review. Compose browser attempts with `--shot <id> --take-id B1` (then B2, B3); these requests cannot be submitted to the API.

### 7. Freeze and compose

```bash
node src/cli.mjs script freeze  --project projects/<client>/V<NNN>
node src/cli.mjs script compose --project projects/<client>/V<NNN>
```

`freeze` stamps the plan hash, the continuity hash and the clean check. `compose` writes one request per generated shot, with the prompt assembled from the plan and `metadata.script.plan_hash` binding it to exactly this reviewed version. Use `--dry-run` first to read the prompt blocks before anything is written.

From here the normal route continues: `$produce-short-video` for the production context, `$generate-seedance-video` or the Kling skills for the request itself, `$review-generated-video` for the takes, `$assemble-short-video` for the master.

## Required handoff

Return:

- the beat list with importance and what each beat is for;
- the shot list with events, durations, shot sizes and anchors;
- the continuity anchors and entity invariants;
- the `script check` result: blockers, warnings, and what was done about each;
- the reviewer's record, including every finding you rejected and why;
- the frozen plan hash and the composed request paths.

## References

- [Shot-plan review rubric](references/shotplan-review-rubric.md)
- [Shot plan and continuity contract](references/shotplan-contract.md)
