---
name: produce-short-video
description: "Plan and orchestrate API or browser short-form videos in any delivery ratio — 9:16 for Shorts and Reels, 16:9, or 1:1 — from a brief through script, storyboard, model routing, generation, review, edit, and delivery. Use when a user wants a complete short-video workflow, wants to combine Kling 3, Kling O3/Video 3.0 Omni, and Seedance, or needs a repeatable production manifest rather than one isolated model prompt."
---

# Produce Short Video

Turn a creative brief into a reproducible production package. Route each shot by its control needs, submit work only through the matching model skill, and keep creative planning separate from paid generation.

## Scope and authority

Use production bootstrap for an actual full-video workflow, including its planning stage. Documentation review and CLI/skill development do not require a production project. Reuse supplied client context, reference answers and approvals; ask only for unresolved information. Prepare authorized local work before requesting execution approval, and continue independent work while a dependent step is blocked. Bootstrap never grants or expands paid-call authority; when resuming, preserve the existing approval recorded in the project.

## Non-negotiable rules

- Treat `skills-source/` as canonical when editing this repository; never edit generated client copies.
- Resolve or initialize the local production context before creative planning. Do not continue a full workflow without a validated `client_id`, `project_id`, and project-specific artifact roots.
- Execute API video jobs through EVOLINK. For the user-selected browser route, use `$generate-browser-video` with Gemini; this is a separate route, not an API gateway substitution.
- If reference availability has not already been resolved, ask the user for existing photos or footage before planning a shot that must preserve a specific person, product, or location. Reuse earlier answers; silence does not establish that no references exist.
- Ingest every accepted reference through `node src/cli.mjs assets add` and clear all blockers from `node src/cli.mjs assets check` before a reference-driven generation. Never alter a user's original file to make it pass.
- Freeze a reviewed shot plan before new production generation. `plan` and `submit` refuse without it and there is no override flag: `script check` → independent review → `script freeze` is the standard path. The only legacy exception is an existing named `approval.script_plan_waiver` covering the specific already-shot `shot_ids`; bootstrap does not create it. What the plan contains is the user's creative decision.
- Use `$develop-shot-plan` to build, review and freeze that plan, and `$vibe-creating-prompt` to distill loose creative input before building model prompts.
- For browser shots use `$generate-browser-video`; the model-specific API skills below apply only to API shots.
- Use `$generate-kling-3-video`, `$generate-kling-o3-video`, or `$generate-seedance-video` for every model-specific request. Do not invent provider fields here.
- Use `$review-generated-video` before accepting a take or sending clips to the edit.
- Use `$assemble-short-video` for deterministic trimming, compositing, captions, exact graphics, sound, and delivery encoding.
- Use `$edit-with-openchatcut` for interactive timeline work in the OpenChatCut editor (transitions, keyframes, styled captions, effects, colour, or an edit the user wants to review in an editor); its export re-enters the project through `adopt-master`.
- Never silently substitute a model, provider, aspect ratio, duration, resolution, or audio mode.
- Use Komend TTS only after review marks required native narration `missing` or `unusable`; do not synthesize a second voice merely because narration text exists.
- Do not make a paid generation call unless the user requested execution and the provider, estimated cost, and retry limit are known or already covered by an explicit budget.
- Record the approved budget in the project manifest (`approval.paid_generation`, `approval.max_total_cost`, and the optional `approved_by`/`approved_at`/`note`). `submit` enforces it before any network call and there is no override flag: raising the cap in the manifest is the only way through, and it is the user's decision.
- Preserve every source asset, request manifest, provider response, and generated take. Never overwrite or delete a failed take.
- Treat model comparisons as routing heuristics, not guarantees. Verify current provider capabilities at runtime.
- Reply and label artifacts in the user's language unless a downstream API requires otherwise.

## Workflow

### 0. Resolve or initialize production

Establish the client before creating briefs, requests, references, or jobs. Require a stable explicit lowercase ASCII `client_id`; keep the display name separate. If the user has not supplied enough client context, ask one question for the client name and stable ID and create nothing yet. Never infer a global active client or merge clients because their display names look similar.

From the repository root, invoke the internal local bootstrap before any other workflow step:

```bash
node scripts/init-production.mjs \
  --client-id acme \
  --client-name "Acme" \
  --video-number 1 \
  --mode ensure
```

Use exactly one of `--video-number <N>` and `--next`. Use `ensure` for “делаем видео №N”, `new` only when the requested number must be unused, and `resume` only when the project must already exist. Pass `--client-name` when creating a client. Use `--legacy-project-root <relative-path>` only for an explicit registration of an existing recognized local project; the bootstrap must not move or rewrite it.

Stop on a conflict, malformed manifest, or bootstrap error. On success, retain the returned context as the only path authority for the workflow. Report whether the project was created or reused and its `project_id`. The bootstrap is local preparation only: a newly created project has `approval.paid_generation=false`; a resumed project retains its recorded approval. Bootstrap itself authorizes no provider or TTS call.

Every video request created afterward must include the production identity in the existing metadata object:

```json
{
  "metadata": {
    "production": {
      "client_id": "acme",
      "project_id": "ACME-V001",
      "video_number": 1
    }
  }
}
```

Preserve any other metadata fields. Never add `client_id` or `project_id` at the request top level. For every `plan` call, pass the returned project-specific root, for example `--jobs-root artifacts/acme/V001/jobs`; never fall back to shared `artifacts/jobs` after bootstrap.

### 1. Establish the production contract

Capture the goal, audience, platform, target length, language, CTA, brand constraints, reference rights, delivery deadline, provider access, and cost ceiling. Resolve only missing answers about existing photos/footage and identity continuity. Obtain the delivery ratio from the user or an already approved brief: it sets `target.aspect_ratio` and the edit's `output.width`/`output.height`. If absent, ask before initializing the shot plan; do not default to 9:16. Continue independent preparation within the validated production context.

Stop before generation when any of these are unresolved:

- identity, likeness, music, voice, logo, or footage rights;
- a realistic synthetic person or event that needs platform disclosure;
- a provider choice that materially changes cost or policy;
- no explicit authority for paid API use.

### 2. Build the creative pack

Invoke `$vibe-creating-prompt` and respect its fit decision. If it selects light cleanup or pass-through, preserve the direct brief and continue without forcing a stylized prompt. Create:

1. one-sentence premise and emotional promise;
2. hook, development, turn, payoff, and CTA;
3. spoken copy with exact dialogue and pronunciation notes;
4. a numbered shot list with duration and edit purpose;
5. a continuity bible for people, wardrobe, props, locations, lighting, color, and screen direction.

For reusable content structures, read [references/creative-formats.md](references/creative-formats.md). Do not make generation prompts verbose merely to sound cinematic.

### 3. Collect, ingest, and check references before spending credits

Read [references/reference-assets.md](references/reference-assets.md) for the intake questions, the
quality checklist to give the user, the role table, and the per-mode capacity.

Use the reference inventory already established; ask only about unresolved assets. Create only what is still missing and whose rights, execution authority and
provider policy are clear:

- character sheet: face, full body, side/back views, wardrobe details;
- location sheet: wide view, reverse angle, layout, recurring landmarks;
- object/product sheet: proportions, labels, materials, interaction states;
- storyboard: one panel per intended edit beat with shot size and direction.

Copy every accepted reference into the project and confirm the set fits the intended route:

```bash
node src/cli.mjs assets add --project projects/acme/V001 \
  --file ~/Downloads/hero-1.jpg --asset-id hero-front --role identity --rights approved

node src/cli.mjs assets check --project projects/acme/V001 \
  --model kling-o3 --mode reference_to_video \
  --video-url https://cdn.example.com/reference.mp4 --video-rights approved
```

Ingestion copies the file and never moves, rewrites, or deletes the user's original. Set
`--rights approved` only on the user's confirmation. Resolve every blocker before generation and
report warnings with the trade-off instead of silently accepting them. For Kling O3 video modes,
pass the required public HTTPS video through `--video-url`; the check validates it through the same
request builder without downloading it. Set `--video-rights approved` only after the user's
confirmation, exactly like image `--rights`.

Use the storyboard to catch repeated angles, impossible geography, and continuity conflicts. Match reference aspect ratios to the target where practical.

### 4. Route shot by shot

Read [references/model-routing.md](references/model-routing.md). Choose an engine for each shot, not one engine for the entire project by habit.

- When the user does not specify a model and no shot-specific constraint requires another route, choose Seedance 2.5 first. Omitting `model` from the normalized request resolves to `seedance-2.5`; record that resolved default exactly like an explicit selection.
- Prefer Kling 3 for controlled short text/image-to-video shots, expressive faces, image-first framing, start/end transitions, or coherent multi-shot work when the provider exposes those modes.
- Prefer Kling O3/Video 3.0 Omni for reference-heavy generation, video transformation, motion transfer, multimodal editing, or timed control when the resolved provider model actually supports it.
- Prefer Seedance 2.5 for storyboard-led sequences, dense multimodal conditioning, complex action/physics, reference-driven continuity, native audio, and documented video edit/extend routes.
- Use the editor for deterministic overlays, timing, color matching, and final sound. Every standalone frame must come from the video model; a rendered UI or slide cannot replace a filmed screen.

Record the reason and any proposed fallback for every routing decision. Recording a fallback does not authorize executing it.

### 5. Develop, review, and freeze the shot plan

For a new plan, invoke `$develop-shot-plan`; when resuming, reuse the unchanged frozen plan or the existing named legacy waiver for its covered shots. A waiver does not authorize new shots. The skill maps every beat of the script to a shot, counts the events each shot has to render, locks the continuity anchors, and has a separate subagent read the result before anything is frozen. A four-second shot renders at most two events; a climax gets a shot to itself. Then:

```bash
node src/cli.mjs script check   --project projects/<client>/VNNN
node src/cli.mjs script review  --project projects/<client>/VNNN --record <review.json>
node src/cli.mjs script freeze  --project projects/<client>/VNNN
node src/cli.mjs script compose --project projects/<client>/VNNN
```

`compose` writes the requests, with each prompt assembled from the frozen plan and bound to it through `metadata.script.plan_hash`. For a risky shot, use an authorized model-generated test take when it can resolve the current uncertainty. Still frames and animatics are planning aids only. Do not replace filmed footage with graphics or spend on extra candidates beyond the approved budget/retry boundary. Keep dialogue early and concise when lip sync is important; split long or overloaded shots.

Create the artifacts and states specified in [references/production-flow.md](references/production-flow.md) only inside the returned production context. Every draft request must have a stable `shot_id`, `take_id`, normalized intent, input hashes where assets exist, and explicit unresolved gates. Before execution it must also contain the exact provider/model identifier, provider payload, and unique output path.

### 6. Preflight and execute

For shots routed to `gemini-browser`, follow `$generate-browser-video`: compose a B-numbered browser request, check the selected profile and visible capabilities/quota, submit through the UI, download and run `browser-import`. API pricing, payload, submit and polling steps below apply only to API shots. Both routes retain the frozen plan, provenance, separate audio and take review.

For each shot (reuse the frozen plan; an existing named legacy waiver replaces only the script-plan binding check for its listed shot_ids, never budget or reference checks):

1. verify that the request contains the resolved `metadata.production` identity, that `metadata.script.plan_hash` matches the frozen plan, and that the video CLI will receive the returned `jobs_root`;
2. invoke the selected model skill;
3. discover the provider schema and current capabilities;
4. validate URLs, MIME types, durations, ratios, policy, cost, and incompatible fields;
5. read the printed `cost_estimate` from `plan` before spending; a route with no measured price reports `unknown_rate` rather than a guess;
6. save the immutable request before submission;
7. submit once with an idempotency key when supported;
8. persist the remote task ID before polling;
9. poll the existing task with bounded backoff; never resubmit because polling failed;
10. download the original output and provider metadata to a new take path.

If an API does not expose a required control, report the mismatch and propose a specific route change. Never approximate it silently.

### 7. Review and revise surgically

Invoke `$review-generated-video` for every take group. Compare candidates at the shot level. Regenerate only failed shots and change one major variable at a time: reference pack, prompt density, mode, duration, or engine.

Open a retry with `node src/cli.mjs retry --job <directory> --change "<the single variable>"`. It allocates the next take, records what failed and why this attempt differs, and deliberately leaves the prompt for you to edit — the choice of variable is the creative decision, and keeping it manual is what keeps one-variable-at-a-time visible in the record.

Read [job recovery](references/job-recovery.md) before retries, reconciliation, or retiring assets. Diagnose refusals from provider evidence. A screen-related failure in another project is a hypothesis, not a reason to hide the screen or replace it with a slide. For a permitted scene, revise one variable within the authorized retry limit; do not remove the visual evidence the beat needs.

Accept a take only when it passes identity/continuity, anatomy/physics, camera, temporal stability, lip sync/audio, policy, and edit-handle checks.

### 8. Assemble and deliver

Invoke `$assemble-short-video` to assemble accepted takes, trim weak heads/tails, and add deterministic titles, captions, music, VO, SFX, color, and loudness. Preserve raw audio even when replacing it. When the cut needs interactive timeline work or the user asks to edit in OpenChatCut, route through `$edit-with-openchatcut` and adopt its export with `node src/cli.mjs adopt-master`; the assembler remains the default delivery route and the adopted master is measured against the same frozen plan.

Export at the delivery ratio the brief asked for, without baked black bars. Prefer MP4/H.264, progressive scan, source frame rate, AAC-LC or Opus audio, and BT.709 SDR unless the delivery target requires another profile. Add the platform's altered/synthetic-content disclosure when realistic content is meaningfully generated or altered.

## Required handoff

Return:

- assumptions, rights/policy status, and approval boundary;
- creative brief, script, frozen shot plan with its hash, continuity anchors, and the reviewer's record;
- ingested reference registry with role, rights status, and the capacity-check verdict per route;
- routing table with engine, mode, reason, fallback, and risk per shot;
- estimated number of paid jobs and cost range when discoverable;
- immutable request/job/output manifests;
- QA decision per take and a final edit decision list;
- delivery settings and disclosure note.

When asked only to plan without a selected provider, stop after producing provider-preflight-ready draft manifests and mark exact `provider`, `model_id`, schema, price, and policy as unresolved gates. Call a manifest generation-ready only after those gates pass. When asked to execute, continue only within the approved provider and budget boundary.

## References

- [Production states and artifact contract](references/production-flow.md)
- [Reference intake, roles, and mode capacity](references/reference-assets.md)
- [Model-routing matrix](references/model-routing.md)
- [Reusable short-video formats](references/creative-formats.md)
- [Research notes and source trail](references/research-notes.md)
