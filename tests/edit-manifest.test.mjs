import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEditManifest } from "../src/domain/edit-manifest.mjs";

function manifest(overrides = {}) {
  return {
    variant_id: "B1",
    output: { masters_root: "artifacts/acme/V001/masters" },
    segments: [
      { id: "hook", kind: "clip", source: "shot.mp4", frames: 96 },
      { id: "cards", kind: "still", source: "card.png", frames: 96 },
    ],
    ...overrides,
  };
}

test("timeline positions are derived from frame counts, never authored", () => {
  const normalized = normalizeEditManifest(manifest());

  assert.equal(normalized.total_frames, 192);
  assert.equal(normalized.total_seconds, 8);
  assert.deepEqual(
    normalized.segments.map((segment) => [segment.id, segment.start_frame, segment.start_seconds]),
    [
      ["hook", 0, 0],
      ["cards", 96, 4],
    ],
  );
});

test("a still sequence keeps per-state frame counts aligned with its sources", () => {
  const normalized = normalizeEditManifest(
    manifest({
      segments: [
        {
          id: "chat",
          kind: "still_sequence",
          sources: ["s0.png", "s1.png", "s2.png", "s3.png", "s4.png"],
          frames: [39, 38, 38, 38, 39],
        },
      ],
    }),
  );
  // 39+38+38+38+39 = 192 = exactly 8 s at 24 fps, which naive "-t 1.6" per state
  // would have rounded down to 190 frames.
  assert.equal(normalized.total_frames, 192);
  assert.equal(normalized.total_seconds, 8);

  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({
          segments: [
            { id: "chat", kind: "still_sequence", sources: ["a.png", "b.png"], frames: [39] },
          ],
        }),
      ),
    /has 2 sources but 1 frame counts/,
  );
});

test("durations must be whole frames", () => {
  assert.throws(
    () => normalizeEditManifest(manifest({ segments: [{ kind: "clip", source: "a.mp4", frames: 38.4 }] })),
    /frames must be an integer/,
  );
  assert.throws(
    () => normalizeEditManifest(manifest({ segments: [{ kind: "clip", source: "a.mp4" }] })),
    /frames must be an integer/,
  );
});

test("ducking windows are derived from which segments actually carry speech", () => {
  const spoken = normalizeEditManifest(
    manifest({
      segments: [
        { id: "hook", kind: "clip", source: "a.mp4", frames: 96, audio: "source" },
        { id: "cards", kind: "still", source: "c.png", frames: 96 },
        { id: "cta", kind: "clip", source: "b.mp4", frames: 120, audio: "source" },
      ],
    }),
  );
  assert.deepEqual(spoken.speech_windows, [
    [0, 4],
    [8, 13],
  ]);

  // A cut with no production audio needs no ducking at all.
  const silent = normalizeEditManifest(
    manifest({
      segments: [{ id: "hook", kind: "clip", source: "a.mp4", frames: 96, audio: "silent" }],
    }),
  );
  assert.deepEqual(silent.speech_windows, []);
});

test("voiceover cues add ducking windows, merged with speech that runs across a cut", () => {
  const plan = normalizeEditManifest(
    manifest({
      segments: [
        { id: "a", kind: "clip", source: "a.mp4", frames: 96, audio: "silent" },
        { id: "b", kind: "clip", source: "b.mp4", frames: 96, audio: "silent" },
      ],
      audio: {
        voiceover: {
          rights: "synthesized_tts",
          cues: [
            { id: "L1", source: "l1.wav", at_seconds: 0.2, duration_seconds: 3 },
            { id: "L2", source: "l2.wav", at_seconds: 3.1, duration_seconds: 2 },
            { id: "L3", source: "l3.wav", at_seconds: 6, duration_seconds: 1.5 },
          ],
        },
      },
    }),
  );
  assert.deepEqual(plan.speech_windows, [
    [0.2, 5.1],
    [6, 7.5],
  ]);
});

test("native effects keep clips out of the speech windows; only the voiceover ducks the bed", () => {
  const plan = normalizeEditManifest(
    manifest({
      segments: [
        { id: "a", kind: "clip", source: "a.mp4", frames: 96, audio: "source" },
        { id: "b", kind: "clip", source: "b.mp4", frames: 96, audio: "source" },
      ],
      audio: {
        native: { role: "effects", gain: 1.5 },
        voiceover: {
          rights: "synthesized_tts",
          cues: [{ id: "L1", source: "l1.wav", at_seconds: 1, duration_seconds: 2 }],
        },
      },
    }),
  );
  assert.deepEqual(plan.speech_windows, [[1, 3]]);
  assert.deepEqual(plan.audio.native, { role: "effects", gain: 1.5, duck_level: 0.35 });

  // Without the block native audio is still dialogue, exactly as before.
  const legacy = normalizeEditManifest(
    manifest({ segments: [{ id: "a", kind: "clip", source: "a.mp4", frames: 96, audio: "source" }] }),
  );
  assert.deepEqual(legacy.speech_windows, [[0, 4]]);
  assert.equal(legacy.audio?.native, undefined);

  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({
          segments: [{ id: "a", kind: "clip", source: "a.mp4", frames: 96, audio: "source" }],
          audio: { native: { role: "music" } },
        }),
      ),
    /audio\.native\.role/,
  );
});

test("a voiceover cue must fit the timeline and declare its rights", () => {
  const segments = [{ id: "a", kind: "clip", source: "a.mp4", frames: 96, audio: "silent" }];
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({
          segments,
          audio: {
            voiceover: { rights: "synthesized_tts", cues: [{ id: "L1", source: "l.wav", at_seconds: 3, duration_seconds: 2 }] },
          },
        }),
      ),
    /ends at 5 s, after the 4 s timeline/,
  );
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({
          segments,
          audio: { voiceover: { cues: [{ id: "L1", source: "l.wav", at_seconds: 0, duration_seconds: 2 }] } },
        }),
      ),
    /audio\.voiceover\.rights/,
  );
});

test("graphics segments cannot claim production audio", () => {
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({ segments: [{ kind: "still", source: "c.png", frames: 24, audio: "source" }] }),
      ),
    /audio must be silent for a still segment/,
  );
});

test("segment ids stay unique so intermediates cannot collide", () => {
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({
          segments: [
            { id: "same", kind: "clip", source: "a.mp4", frames: 24 },
            { id: "same", kind: "clip", source: "b.mp4", frames: 24 },
          ],
        }),
      ),
    /Duplicate segment id: same/,
  );
});

test("music rights must be stated explicitly, and a placeholder says so", () => {
  const normalized = normalizeEditManifest(
    manifest({
      audio: { music: { source: "bed.wav", rights: "synthesized_placeholder" } },
    }),
  );
  assert.equal(normalized.audio.music.rights, "synthesized_placeholder");
  assert.deepEqual(normalized.audio.target_lufs, [-20, -16]);
  assert.equal(normalized.audio.limit, 0.84);

  assert.throws(
    () => normalizeEditManifest(manifest({ audio: { music: { source: "bed.wav" } } })),
    /audio\.music\.rights must be one of/,
  );
});

test("the loudness target must be an ordered floor/ceiling pair", () => {
  assert.throws(
    () => normalizeEditManifest(manifest({ audio: { target_lufs: [-16, -20] } })),
    /ordered \[floor, ceiling\]/,
  );
  assert.throws(
    () => normalizeEditManifest(manifest({ audio: { target_lufs: [-16] } })),
    /\[floor, ceiling\] pair/,
  );
});

test("unknown fields are rejected rather than silently ignored", () => {
  assert.throws(() => normalizeEditManifest(manifest({ transitions: [] })), /unsupported field: transitions/);
  assert.throws(
    () => normalizeEditManifest(manifest({ segments: [{ kind: "clip", source: "a.mp4", frames: 24, fade: 1 }] })),
    /unsupported field: fade/,
  );
});

test("fit is declared per output or per segment and stays absent when nobody declared it", () => {
  const plain = normalizeEditManifest(manifest());
  assert.equal(Object.hasOwn(plain.output, "fit"), false);
  assert.equal(Object.hasOwn(plain.segments[0], "fit"), false);

  const declared = normalizeEditManifest(
    manifest({
      output: { masters_root: "artifacts/acme/V001/masters", fit: "pad" },
      segments: [
        { id: "hook", kind: "clip", source: "shot.mp4", frames: 96, fit: "cover" },
        { id: "cards", kind: "still", source: "card.png", frames: 96 },
      ],
    }),
  );
  assert.equal(declared.output.fit, "pad");
  assert.equal(declared.segments[0].fit, "cover");
  assert.equal(Object.hasOwn(declared.segments[1], "fit"), false);
});

test("an unknown fit mode is refused instead of falling back to a silent stretch", () => {
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({ output: { masters_root: "artifacts/acme/V001/masters", fit: "letterbox" } }),
      ),
    /output\.fit must be one of: pad, cover, stretch/,
  );
  assert.throws(
    () =>
      normalizeEditManifest(
        manifest({ segments: [{ kind: "clip", source: "a.mp4", frames: 24, fit: "squish" }] }),
      ),
    /fit must be one of: pad, cover, stretch/,
  );
});
