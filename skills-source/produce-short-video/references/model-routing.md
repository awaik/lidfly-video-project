# Model-routing matrix

This matrix is a starting heuristic, not a benchmark guarantee. Resolve the actual provider model and test the risky shot at draft quality.

When the user omits the model, start with Seedance 2.5. Override that default only for a documented
shot-specific control or an explicit user choice, and record the change rather than silently falling
back after a failed request.

## Decision matrix

| Dominant control need | Primary route | Alternative | Main QA risk |
| --- | --- | --- | --- |
| Explore a scene from text | Seedance 2.5 text-to-video | Kling 3 | Composition variance |
| Preserve an exact opening composition | Seedance 2.5 image-to-video | Kling 3 image-to-video | First-frame drift |
| Bridge known start and end frames | Seedance 2.5 image-to-video | Kling 3 start/end mode | Morphing mid-clip |
| Several related camera beats in one task | Kling 3 or O3 multi-shot | Seedance timeline | Missed beats, lip-sync drift |
| Strong identity/location references | Seedance 2.5 reference-to-video | Kling O3/Omni | Reference blending/leakage |
| Transform an existing source video | Seedance 2.5 video edit | Kling O3/Omni | Source identity and motion fidelity |
| Extend a source video forward/backward | Seedance 2.5 video extend | Deterministic edit when possible | Continuity at the join |
| Complex action, contact, or physical causality | Seedance 2.5 | O3/Omni | Hands, topology, gravity |
| Animate an explicit storyboard | Seedance 2.5 | O3 storyboard mode if exposed | Panel order and cut timing |
| Dialogue-led emotional close-up | Seedance 2.5 short clip | Kling 3 | Exact words and lip sync |
| Consecutive shots with a carried end frame | Seedance 2.5 image-to-video | Kling start/end | Accumulating identity drift |
| Exact title, UI, logo, caption, or product label | Editor/compositor | Generated plate plus overlay | Text corruption |
| Deterministic color, pace, transition, or sound mix | Editor/DAW | None | Unrepeatable generation |

## Routing questions

Ask in order:

1. What single failure would make this shot unusable?
2. Is the required control generative or deterministic post-production?
3. Does a provider expose a documented mode for that control?
4. Can the action fit into one simple clip, or should it be split?
5. Which references have one clear role and sufficient quality?
6. What is the cheapest draft that proves the risk?
7. What is the fallback if the first engine fails twice for the same reason?

## Complexity budget

Treat these as competing demands:

- number of characters;
- number of references;
- cuts or camera changes;
- physical interactions;
- spoken lines;
- identity/style transformation;
- exact start/end states;
- native sound requirements.

If a shot asks for several of them, simplify or split before switching engines. A model change does not repair an impossible timing budget.

## Fallback policy

- Retry the same model after changing one major variable only when the failure has a plausible prompt/reference cause.
- Reroute when the failure matches a missing control or repeats across two materially different takes.
- Move exact graphics, captions, logos, compositing, and sound replacement to post.
- Never reroute silently. Record the rejected take, reason, model change, cost impact, and approval status.

## Evidence level

- **First-party capability:** may guide preflight, but provider exposure still needs verification.
- **Provider documentation:** controls exact payload construction for that provider and revision.
- **YouTube workflow observation:** useful for draft strategy and QA, never proof of an API limit.
- **One-project result:** record as shot-specific evidence, not a global model ranking.
