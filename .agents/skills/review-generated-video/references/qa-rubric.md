# AI-video QA rubric

Apply hard gates first. Score only takes that survive them.

## Hard gates

| Gate | Pass condition |
| --- | --- |
| Policy and rights | No disallowed output; intended identities/assets are authorized; disclosure flag recorded |
| Provenance | Output maps to one saved request, provider/model, task ID, and immutable hash |
| Media integrity | File decodes; required video/audio exists; no terminal corruption |
| Core intent | Main subject, action, and narrative result are present |
| Identity/product | No wrong identity, severe reference blending, or unusable product geometry |
| Physical usability | No severe anatomy, contact, topology, or causality failure in the usable interval |
| Dialogue | Required spoken meaning is intelligible and materially correct |
| Editability | At least one continuous range can be cut into the intended sequence |

Any hard-gate failure produces `reject`, `regenerate`, or `reroute` regardless of numeric score.

## Weighted score

Score each category from 0 to 5, then multiply by weight.

| Category | Weight | What to inspect |
| --- | ---: | --- |
| Intent and reference adherence | 25 | Subject, action, setting, start/end state, storyboard, product/wardrobe |
| Temporal stability | 15 | Flicker, morphing, texture crawl, disappearing objects, cut continuity |
| Anatomy and physics | 15 | Hands, faces, joints, contact, weight, gravity, fluids, collisions |
| Camera and composition | 10 | Requested shot, movement, horizon, focus, safe title/crop area |
| Continuity | 10 | Identity, wardrobe, props, geography, screen direction, light/color |
| Audio and dialogue | 15 | Words, timing, lip sync, speaker, noise, SFX, music, clipping |
| Editability | 10 | Clean handles, pacing, usable in/out, ability to repair defects in post |

Calculate percentage as:

```text
sum((category_score / 5) * weight)
```

Suggested decision bands after hard gates:

- 85-100: accept or accept with minor post;
- 70-84: conditional; compare candidates and define exact post work;
- below 70: regenerate or reroute.

The bands are defaults. A project may set stricter shot-specific thresholds.

## Inspection passes

### Visual pass

1. Watch at normal speed.
2. Watch silent to isolate motion and cuts.
3. Inspect the opening, midpoint, end, every cut, and every contact event frame by frame.
4. Compare identity/product against references at wide, medium, and close moments.
5. Check the intended crop and overlay-safe areas.

### Audio pass

1. Listen on headphones and speakers when delivery risk warrants it.
2. Transcribe required speech and compare it with the approved text.
3. Inspect lip sync around plosives and syllable starts, not only broad mouth motion.
4. Check unwanted voices/music, clipping, pumping, phase, and abrupt ambience changes.
5. Confirm the legal disposition of music and cloned/synthetic voice.

### Continuity pass

Compare the take with the previous accepted shot, the next planned shot, and the continuity bible. Check:

- face, hair, wardrobe, accessories;
- product orientation, hand, state, and labels;
- entrances/exits and screen direction;
- location layout and recurring landmarks;
- light direction, time of day, palette, and weather;
- final frame suitability for the next cut.

## Review record

```json
{
  "schema_version": 1,
  "shot_id": "S001",
  "take_id": "T002",
  "output_sha256": "...",
  "hard_gates": {
    "passed": true,
    "failures": []
  },
  "scores": {
    "intent_reference": 4,
    "temporal_stability": 4,
    "anatomy_physics": 3,
    "camera_composition": 5,
    "continuity": 4,
    "audio_dialogue": 3,
    "editability": 5,
    "weighted_percent": 78
  },
  "evidence": [
    {
      "time_seconds": 2.4,
      "finding": "brief finger fusion outside selected edit range"
    }
  ],
  "usable_range": {
    "in_seconds": 0.4,
    "out_seconds": 2.2
  },
  "decision": "accept_with_post",
  "post_actions": ["replace generated click SFX", "add exact logo overlay"],
  "regeneration_change": null
}
```

## Regeneration diagnosis

| Failure pattern | First change to test |
| --- | --- |
| Wrong composition from text | Add an approved start frame or storyboard panel |
| Identity drift | Improve/trim identity references; simplify other constraints |
| Reference blending | Remove redundant references and assign explicit roles |
| Skipped timeline beat | Reduce beat count or extend duration within provider limits |
| Broken physical contact | Shorten action, add intermediate storyboard state, or route to action-strong model |
| Start/end morph | Simplify transition path or split into two shots with a hidden edit |
| Dialogue/lip-sync drift | Shorten line, put it earlier, use cutaways, or replace in post |
| Text/logo corruption | Generate a clean plate and composite exact graphics |
| Aspect-ratio jump | Re-crop references and make output framing explicit |
| Repeated same model failure | Reroute after documenting both attempts and approval/cost impact |

Change one major variable per diagnostic take so the result remains interpretable.
