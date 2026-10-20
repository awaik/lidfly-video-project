const SHOT_SIZE_PHRASES = Object.freeze({
  extreme_close_up: "Extreme close-up",
  close_up: "Close-up",
  medium_close_up: "Medium close-up",
  medium: "Medium shot",
  medium_wide: "Medium wide shot",
  wide: "Wide shot",
  extreme_wide: "Extreme wide shot",
  insert: "Insert shot",
});

const WORLD_ANCHOR_KINDS = new Set(["location", "palette", "weather", "prop", "screen_direction"]);

function anchorsOfKinds(continuity, shot, kinds) {
  return shot.continuity_keys
    .filter((key) => kinds.has(continuity.anchors[key]?.kind))
    .sort()
    .map((key) => continuity.anchors[key].text);
}

function eventWindows(shot) {
  const declared = shot.events.filter((event) => event.window_seconds);
  if (declared.length === shot.events.length && declared.length > 0) {
    return shot.events.map((event) => event.window_seconds);
  }
  // No declared windows: split the shot evenly so the model still gets an order
  // and a pace instead of a pile of simultaneous actions.
  const share = shot.duration_seconds / Math.max(1, shot.events.length);
  return shot.events.map((_event, index) => [
    Math.round(index * share * 10) / 10,
    Math.round((index + 1) * share * 10) / 10,
  ]);
}

/**
 * Build a shot prompt from the frozen plan and the project's continuity.
 *
 * The prompt is assembled, never authored: a shot has no prompt field at all.
 * That is what keeps the event count honest — prose cannot smuggle a fourth
 * action into a four-second shot when the text is generated from the events.
 */
export function composeShotPrompt({ plan, continuity, shot }) {
  const blocks = [];
  const push = (name, text) => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    // Blocks are joined with a space, so each one has to close its own sentence
    // or the next block reads as a continuation of it.
    blocks.push({ name, text: /[.!?»]$/.test(trimmed) ? trimmed : `${trimmed}.` });
  };

  push("style", continuity.global_prompt_block);
  push("world", anchorsOfKinds(continuity, shot, WORLD_ANCHOR_KINDS).join(" "));
  push("light", anchorsOfKinds(continuity, shot, new Set(["light"])).join(" "));

  const entityLines = shot.subject
    .map((id) => {
      const entity = continuity.entities[id];
      if (!entity) return null;
      const invariants = entity.invariants.length ? ` Always: ${entity.invariants.join("; ")}.` : "";
      return `${entity.prompt_text}.${invariants}`;
    })
    .filter(Boolean);
  push("entities", entityLines.join(" "));
  push("scale", anchorsOfKinds(continuity, shot, new Set(["scale", "wardrobe"])).join(" "));

  const framing = [
    SHOT_SIZE_PHRASES[shot.shot_size],
    shot.camera ? shot.camera : null,
    shot.start_state ? `Opens on: ${shot.start_state}.` : null,
  ]
    .filter(Boolean)
    .join(". ");
  push("framing", framing);

  const windows = eventWindows(shot);
  const events = shot.events
    .map((event, index) => {
      const [start, end] = windows[index];
      const reads = event.reads_as ? ` ${event.reads_as}.` : "";
      return `${start}-${end}s: ${event.text}.${reads}`;
    })
    .join(" ");
  push("events", events);

  const audio = [
    shot.audio_intent.length ? `Sound: ${shot.audio_intent.join(", ")}.` : null,
    shot.dialogue ? `Spoken line: «${shot.dialogue}».` : null,
  ]
    .filter(Boolean)
    .join(" ");
  push("audio", audio);

  push("note", shot.style_note ?? "");
  push("negative", continuity.negative_prompt_block);

  return { prompt: blocks.map((block) => block.text).join(" "), blocks };
}
