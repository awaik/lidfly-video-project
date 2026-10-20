# Shot-plan review rubric

The reviewer reads three things: the source script, the plan documents, and the `script check` output. It never sees the director's rationale, because a justification read before the work is judged is an argument, not evidence.

Read [the visual storytelling standard](visual-storytelling.md) when reviewing camera, rhythm, screen evidence and comparisons. Approved creative exceptions must be visible in the plan/source material; they do not clear machine blockers.

## Hard gates

A plan that fails any of these is `revise`, whatever it scores.

| Gate | Pass condition |
| --- | --- |
| Beat coverage | Every `required` and `climax` beat is covered by at least one shot |
| Climax isolation | The climax beat has its own shot with a single event |
| Shot density | No shot carries more events than `floor(duration/2)`, and never more than three |
| Continuity anchors | Every generated shot carries each anchor kind the project declares required |
| Scale discipline | Every entity with a `scale_anchor` carries it in each shot it appears in |
| Identity plan | Every entity with identity references has one supplied in every reference-capable shot it appears in |
| Protagonist readability | At least one close shot of the protagonist, and the signature feature can actually be seen in it |
| Duration | The sum of timeline seconds matches the target within its tolerance |
| Route | Every shot builds into a valid provider request |

## Weighted score

Score each category 0–5, then `sum((score / 5) * weight)`.

| Category | Weight | What to look for |
| --- | --- | --- |
| Beat coverage | 25 | Is the story still the story after the cut? Which beat would the audience miss? |
| Shot density and readability | 20 | Will each event physically render in the seconds it was given? |
| Continuity anchors | 20 | Does the world hold still between neighbouring shots? |
| Identity and reference plan | 15 | Will the same character look like the same character? |
| Shot-size variety and protagonist readability | 10 | Does the audience ever see a face, and is the cut varied enough to hold attention? |
| Duration and budget fit | 10 | Does the plan fit the target length and the approved spend? |

**85–100** approve · **70–84** approve only if every finding is a warning · **below 70** revise.

## Inspection passes

### Coverage pass

Compare the source script against the beat list first: flag missing story content or a required/climax beat relabeled optional without an approved scope change. Then take the beats one at a time. For each: which shot serves it, and what exactly will the audience see that makes the beat land? A beat covered by a shot that never depicts it is not covered. Record a verdict per beat — this is what makes a superficial review visible.

### Density pass

Take the events one at a time. Ask what physically has to happen on screen, and whether it fits the window. A four-second shot renders two events well; four events means the middle two disappear, and if one of them was the climax, the scene has no climax.

### Continuity pass

Walk the shots in order. At every junction: same location or a declared change? Same light or a declared time jump? Same scale for every creature in frame? Does anything in the plan let the model choose the world again from scratch?

### Readability pass

Ask what a viewer knows about the protagonist after watching. If the answer is "there was a person", say so — that is a finding, not a nuance.

## Review record

```json
{
  "schema_version": 1,
  "project_id": "<PROJECT>-V001",
  "plan_hash": "<hash from script check>",
  "reviewer_pass": 1,
  "beat_verdicts": [
    { "beat_id": "B06", "covered_by": [], "verdict": "fail",
      "note": "бит поворота отсутствует: зритель не увидит момент решения" }
  ],
  "findings": [
    { "level": "blocker", "code": "climax_shared_with_setup", "shot_id": "S005",
      "message": "кульминация делит четыре секунды с ударом лап и прыжком" }
  ],
  "scores": { "beat_coverage": 2, "shot_density": 1, "continuity_anchors": 3,
              "identity_plan": 4, "readability": 2, "duration_budget": 5,
              "weighted_percent": 51 },
  "verdict": "revise",
  "reviewed_at": "2026-08-17T09:40:00.000Z",
  "reviewer": "independent-subagent"
}
```

Keep review notes at most 600 characters; each beat verdict is `pass` or `fail`.

## Rewrite diagnosis

| Symptom | First change to make |
| --- | --- |
| A required beat has no shot | Cover it with a shot; merge compatible setup shots if necessary. Propose a scope change only for the user to approve before changing importance |
| A shot carries too many events | Split it, or lengthen it — never compress the description |
| The climax shares a shot | Give it its own shot with one event and let the reaction land in the next |
| Location flickers between shots | Add the missing anchor, or declare `location_change: true` |
| Light flips away and back | Align the light anchor, or declare `time_jump: true` on the shot that jumps |
| A creature changes size | Add its `scale_anchor` to every shot it appears in |
| The protagonist is never close | Convert the least informative shot to a close-up |
| Total duration does not fit | Trim timeline seconds, not beats |
