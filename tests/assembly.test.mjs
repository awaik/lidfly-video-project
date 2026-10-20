import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeEditManifest } from "../src/domain/edit-manifest.mjs";
import { assembleMaster, atempoChain, duckingExpression, verifyMaster } from "../src/workflows/assembly.mjs";

/**
 * Records the ffmpeg command lines instead of running them, so the assembly
 * decisions can be asserted without encoding video in a unit test.
 */
function stubTools({
  frames = 192,
  loudness = { integrated_lufs: -17, true_peak_dbtp: -1.5, lra: 3 },
  freeze = [],
  // Per-path source dimensions, so a test can express a source whose shape
  // disagrees with the master. Anything unlisted is already output-shaped.
  sourceSizes = {},
} = {}) {
  const commands = [];
  return {
    commands,
    tools: {
      async runFfmpeg(args) {
        commands.push(args.join(" "));
        // The concat step reads real files, so leave a placeholder behind.
        await writeFile(args.at(-1), "stub", "utf8");
      },
      async probeMedia(path) {
        const named = Object.entries(sourceSizes).find(([name]) => String(path).endsWith(name));
        const [width, height] = named?.[1] ?? [720, 1280];
        return {
          duration_seconds: 8,
          video: { codec: "h264", width, height, frame_rate: 24, pix_fmt: "yuv420p" },
          audio: { codec: "aac", sample_rate: 48_000, channels: 2 },
        };
      },
      async countFrames() {
        return frames;
      },
      async measureLoudness() {
        return loudness;
      },
      async measureWindow(_path, window) {
        return { ...window, mean_db: -18, max_db: -2 };
      },
      async detectBlackAndFreeze() {
        return { black: [], freeze };
      },
    },
  };
}

/**
 * Write the manifest and create every file it points at.
 *
 * Assembly fingerprints its inputs, so a manifest that references a missing file
 * is now an error rather than something ffmpeg discovers halfway through.
 */
async function writeManifest(directory, manifest) {
  const path = join(directory, "edit.json");
  await writeFile(path, JSON.stringify(manifest), "utf8");
  const inputs = new Set();
  for (const segment of manifest.segments ?? []) {
    if (segment.sources) for (const source of segment.sources) inputs.add(source);
    if (segment.source) inputs.add(segment.source);
    for (const overlay of segment.overlays ?? []) inputs.add(overlay.asset);
  }
  if (manifest.audio?.music?.source) inputs.add(manifest.audio.music.source);
  for (const cue of manifest.audio?.voiceover?.cues ?? []) inputs.add(cue.source);
  for (const input of inputs) {
    await writeFile(join(directory, input), `stub:${input}`, "utf8");
  }
  return path;
}

function baseManifest(overrides = {}) {
  return {
    variant_id: "B1",
    output: { masters_root: "masters" },
    segments: [
      { id: "hook", kind: "clip", source: "shot.mp4", frames: 96, audio: "silent" },
      { id: "cards", kind: "still", source: "card.png", frames: 96 },
    ],
    audio: { music: { source: "bed.wav", rights: "synthesized_placeholder" } },
    ...overrides,
  };
}

test("ducking curve follows the speech windows and is omitted without speech", () => {
  const curve = duckingExpression([[0, 4], [8, 12]], { level: 0.16, ramp_seconds: 0.4 });
  assert.match(curve, /min\(1,max\(0,\(t-0\)\/0\.4\)\)/);
  assert.match(curve, /min\(1,max\(0,\(t-7\.6\)\/0\.4\)\)/);
  assert.match(curve, /0\.8400/, "ducks by 1 - level");
  assert.equal(duckingExpression([], { level: 0.16, ramp_seconds: 0.4 }), null);
});

test("graphics segments get a silent track so concat stays aligned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
  const { commands, tools } = stubTools();
  await assembleMaster(await writeManifest(directory, baseManifest()), {
    workspaceRoot: directory,
    tools,
  });

  const still = commands.find((command) => command.includes("cards-v1.mov"));
  assert.match(still, /anullsrc=channel_layout=stereo:sample_rate=48000/);
  // Every segment ends up with the same encoder profile.
  for (const command of commands.filter((entry) => /seg|hook|cards/.test(entry))) {
    assert.match(command, /-c:a pcm_s24le/);
  }
});

test("segment durations are cut by frame count, not by seconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-frames-"));
  const { commands, tools } = stubTools();
  await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        segments: [
          {
            id: "chat",
            kind: "still_sequence",
            sources: ["s0.png", "s1.png", "s2.png", "s3.png", "s4.png"],
            frames: [39, 38, 38, 38, 39],
          },
        ],
      }),
    ),
    { workspaceRoot: directory, tools },
  );

  const sequence = commands.find((command) => command.includes("chat-v1.mov"));
  for (const frames of [39, 38]) {
    assert.ok(sequence.includes(`trim=end_frame=${frames}`), `states are trimmed to ${frames} frames`);
  }
  assert.match(sequence, /concat=n=5:v=1:a=0/);
});

test("audio sample rounding follows timeline boundaries, including silent and retimed cuts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-samples-"));
  const { commands, tools } = stubTools({ frames: 4 });
  const report = await assembleMaster(await writeManifest(directory, baseManifest({
    output: { masters_root: "masters", frame_rate: 24, audio_sample_rate: 44100 },
    segments: [
      { id: "native", kind: "clip", source: "shot.mp4", frames: 1, audio: "source" },
      { id: "silent", kind: "still", source: "card.png", frames: 1 },
      { id: "retimed", kind: "clip", source: "shot.mp4", frames: 1, speed: 0.5, audio: "source" },
      { id: "last", kind: "still", source: "card.png", frames: 1 },
    ],
    audio: undefined,
  })), { workspaceRoot: directory, tools });
  const sampleCounts = commands.flatMap((command) => [...command.matchAll(/atrim=end_sample=(\d+)/g)].map((match) => Number(match[1])));
  assert.deepEqual(sampleCounts, [1838, 1837, 1838, 1837]);
  assert.equal(sampleCounts.reduce((sum, count) => sum + count, 0), 7350);
  const list = await readFile(join(directory, "masters", "B1", "_intermediates", "concat-v1.txt"), "utf8");
  assert.equal((list.match(/^duration /gm) ?? []).length, 4, "container durations cannot move frame boundaries");
  assert.match(commands.at(-1), /-c:v copy -c:a aac/, "encode delivery AAC exactly once, even without a mix");
  assert.equal(report.inputs_fingerprint.assembler_revision, 5, "old padded masters must not be reused");
});

test("a silent cut normalizes the bed; a spoken cut ducks it under speech instead", async () => {
  const silentDirectory = await mkdtemp(join(tmpdir(), "lidfly-mix-silent-"));
  const silent = stubTools();
  await assembleMaster(await writeManifest(silentDirectory, baseManifest()), {
    workspaceRoot: silentDirectory,
    tools: silent.tools,
  });
  const silentMix = silent.commands.at(-1);
  assert.match(silentMix, /loudnorm=I=-18/, "the bed carries the whole mix");
  assert.doesNotMatch(silentMix, /volume=eval=frame/, "nothing to duck under");
  assert.match(silentMix, /alimiter=limit=0\.84:level=disabled/);

  const spokenDirectory = await mkdtemp(join(tmpdir(), "lidfly-mix-spoken-"));
  const spoken = stubTools();
  await assembleMaster(
    await writeManifest(
      spokenDirectory,
      baseManifest({
        segments: [
          { id: "hook", kind: "clip", source: "shot.mp4", frames: 96, audio: "source" },
          { id: "cards", kind: "still", source: "card.png", frames: 96 },
        ],
      }),
    ),
    { workspaceRoot: spokenDirectory, tools: spoken.tools },
  );
  const spokenMix = spoken.commands.at(-1);
  assert.match(spokenMix, /volume=eval=frame/, "music is ducked");
  assert.match(spokenMix, /loudnorm=I=-15.*\[speech\]/, "speech is normalized on its own");
  // A loudnorm across the finished mix would undo the ducking.
  assert.doesNotMatch(spokenMix, /amix.*loudnorm/);
  assert.match(spokenMix, /alimiter=limit=0\.84:level=disabled/);
});

test("a separate voiceover is placed by cue, normalized on its own and ducks the bed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-mix-voiceover-"));
  const { commands, tools } = stubTools();
  const report = await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        audio: {
          music: { source: "bed.wav", rights: "licensed" },
          voiceover: {
            rights: "synthesized_tts",
            cues: [
              { id: "L1", source: "l1.wav", at_seconds: 0, duration_seconds: 8 },
            ],
          },
        },
      }),
    ),
    { workspaceRoot: directory, tools },
  );
  const mix = commands.at(-1);
  assert.match(mix, /-i \S*l1\.wav/, "the cue is an input of its own");
  assert.match(mix, /\[2:a\].*adelay=0\|0/, "the cue lands at its declared time");
  assert.match(mix, /loudnorm=I=-15:TP=-2:LRA=11,volume=1\[voiceover\]/, "the voice bus is normalized alone");
  assert.match(mix, /volume=eval=frame/, "music ducks under the voiceover");
  assert.doesNotMatch(mix, /\[speech\]/, "silent clips add no native speech bus");
  assert.doesNotMatch(mix, /amix.*loudnorm/);
  assert.equal(report.audio.voiceover.rights, "synthesized_tts");
  assert.deepEqual(report.audio.speech_windows, [[0, 8]]);
});

test("native effects stay at their own level and duck under the voiceover instead of being normalized as speech", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-mix-native-effects-"));
  const { commands, tools } = stubTools();
  const report = await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        segments: [{ id: "cat", kind: "clip", source: "shot.mp4", frames: 240, audio: "source" }],
        audio: {
          music: { source: "bed.wav", rights: "licensed" },
          native: { role: "effects", gain: 2, duck_level: 0.3 },
          voiceover: {
            rights: "synthesized_tts",
            cues: [{ id: "L1", source: "l1.wav", at_seconds: 1, duration_seconds: 8 }],
          },
        },
      }),
    ),
    { workspaceRoot: directory, tools },
  );
  const mix = commands.at(-1);
  assert.match(mix, /\[0:a\]aresample=48000,volume=eval=frame:volume='[^']*0\.7000[^']*',volume=2\[native\]/, "effects duck under the cue");
  assert.doesNotMatch(mix, /\[speech\]/, "effects are not a speech bus");
  assert.doesNotMatch(mix, /\[0:a\][^;]*loudnorm/, "effects are not normalized to dialogue loudness");
  assert.match(mix, /\[native\]\[voiceover\]\[music\]amix=inputs=3/);
  assert.deepEqual(report.audio.speech_windows, [[1, 9]], "music ducks only under the voiceover");
  assert.equal(report.audio.native.role, "effects");
});

test("a voiceover cue whose declared length disagrees with its file is refused before encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-mix-voiceover-length-"));
  const { commands, tools } = stubTools();
  const manifestPath = await writeManifest(
    directory,
    baseManifest({
      audio: {
        voiceover: {
          rights: "synthesized_tts",
          cues: [{ id: "L1", source: "l1.wav", at_seconds: 0, duration_seconds: 3 }],
        },
      },
    }),
  );
  await assert.rejects(assembleMaster(manifestPath, { workspaceRoot: directory, tools }), /declares 3 s but/);
  assert.equal(commands.length, 0);
});

test("an unchanged manifest returns the master it already built", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-versions-"));
  const manifestPath = await writeManifest(directory, baseManifest());

  const first = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  const second = stubTools();
  const repeat = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: second.tools });

  assert.equal(first.version, "v1");
  assert.equal(first.reused, false);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.master_path, first.master_path);
  // Nothing was re-encoded: the second run did not call ffmpeg at all.
  assert.deepEqual(second.commands, []);

  const masters = (await readdir(join(directory, "masters", "B1"))).filter((name) => name.endsWith(".mp4"));
  assert.deepEqual(masters, ["B1-master-v1.mp4"]);

  // A verification report is written next to every master.
  const report = JSON.parse(
    await readFile(join(directory, "masters", "B1", "B1-master-v1.report.json"), "utf8"),
  );
  assert.equal(report.audio.music_rights, "synthesized_placeholder");
  assert.match(report.inputs_fingerprint.fingerprint, /^[a-f0-9]{64}$/);
});

test("--force rebuilds, and an edited manifest gets its own version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-force-"));
  const manifestPath = await writeManifest(directory, baseManifest());
  await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });

  const forced = await assembleMaster(manifestPath, {
    workspaceRoot: directory,
    tools: stubTools().tools,
    force: true,
  });
  assert.equal(forced.version, "v2");

  // Changing an input file invalidates the fingerprint on its own.
  await writeFile(join(directory, "shot.mp4"), "different bytes", "utf8");
  const rebuilt = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.equal(rebuilt.reused, false);
  assert.equal(rebuilt.version, "v3");
});

test("a manifest pointing at a missing file fails before any encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-missing-"));
  const manifestPath = await writeManifest(directory, baseManifest());
  await rm(join(directory, "shot.mp4"));

  const { commands, tools } = stubTools();
  await assert.rejects(
    assembleMaster(manifestPath, { workspaceRoot: directory, tools }),
    /references a file that does not exist/,
  );
  assert.deepEqual(commands, []);
});

test("a retimed clip stretches picture and sound by the same factor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-speed-"));
  const { commands, tools } = stubTools();
  await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        segments: [
          { id: "slow", kind: "clip", source: "shot.mp4", frames: 152, speed: 0.6218 },
          { id: "cards", kind: "still", source: "card.png", frames: 40 },
        ],
      }),
    ),
    { workspaceRoot: directory, tools },
  );

  const slow = commands.find((command) => command.includes("slow-v1.mov"));
  // 1/0.6218 stretches the picture; atempo matches it on the audio side.
  assert.match(slow, /setpts=1\.608234\*PTS/);
  assert.match(slow, /atempo=0\.6218/);
  // 152 frames at 24 fps is 6.333 s of output, so 3.938 s of source is consumed.
  assert.match(slow, /atrim=start=0:duration=3\.938067/);
  assert.match(slow, /apad,atrim=end_sample=304000/);
  // Motion interpolation stays off unless it was asked for.
  assert.doesNotMatch(slow, /minterpolate/);
});

test("motion interpolation is opt-in and runs after the delivery scale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-minterp-"));
  const { commands, tools } = stubTools();
  await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        segments: [
          {
            id: "slow",
            kind: "clip",
            source: "shot.mp4",
            frames: 96,
            speed: { factor: 0.5, interpolation: "motion" },
          },
          { id: "cards", kind: "still", source: "card.png", frames: 96 },
        ],
      }),
    ),
    { workspaceRoot: directory, tools },
  );

  const slow = commands.find((command) => command.includes("slow-v1.mov"));
  assert.match(slow, /scale=720:1280,setsar=1,minterpolate=fps=24:mi_mode=mci/);
  assert.match(slow, /atempo=0\.5/);
});

test("speed decomposes into steps atempo accepts", () => {
  assert.equal(atempoChain(1), "atempo=1");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.equal(atempoChain(3), "atempo=2,atempo=1.5");
});

test("retiming a still is refused: its length is already stated in frames", () => {
  assert.throws(
    () =>
      normalizeEditManifest(
        baseManifest({ segments: [{ id: "cards", kind: "still", source: "card.png", frames: 24, speed: 0.5 }] }),
      ),
    /speed is only valid for a clip segment/,
  );
});

test("a still that is frozen by design is not reported as a defect", async () => {
  const manifest = normalizeEditManifest(baseManifest());
  const graphicsFreeze = await verifyMaster(
    "master.mp4",
    manifest,
    stubTools({ freeze: [{ start: 5.5 }] }).tools,
  );
  assert.equal(graphicsFreeze.frozen_stretches.length, 1);
  assert.deepEqual(graphicsFreeze.frozen_in_footage, []);
  assert.deepEqual(graphicsFreeze.issues, []);
  assert.equal(graphicsFreeze.status, "ok");

  // The same detection inside generated footage is a real stall.
  const footageFreeze = await verifyMaster(
    "master.mp4",
    manifest,
    stubTools({ freeze: [{ start: 1.5 }] }).tools,
  );
  assert.equal(footageFreeze.frozen_in_footage.length, 1);
  assert.match(footageFreeze.issues[0], /frozen stretches inside generated footage/);
  assert.equal(footageFreeze.status, "review_required");
});

test("verification flags a timeline that does not match the manifest", async () => {
  const manifest = normalizeEditManifest(baseManifest());
  const result = await verifyMaster("master.mp4", manifest, stubTools({ frames: 190 }).tools);

  assert.match(result.issues[0], /frame count is 190, manifest declares 192/);
  assert.equal(result.status, "review_required");
});

test("verification flags a mix that is too quiet or too hot", async () => {
  const manifest = normalizeEditManifest(baseManifest());
  const quiet = await verifyMaster(
    "master.mp4",
    manifest,
    stubTools({ loudness: { integrated_lufs: -28, true_peak_dbtp: -6, lra: 3 } }).tools,
  );
  assert.match(quiet.issues[0], /integrated loudness -28 LUFS is outside the declared target/);

  const hot = await verifyMaster(
    "master.mp4",
    manifest,
    stubTools({ loudness: { integrated_lufs: -17, true_peak_dbtp: -0.3, lra: 3 } }).tools,
  );
  assert.match(hot.issues[0], /true peak -0\.3 dBTP leaves no headroom/);
});

test("a source shaped unlike the master is refused before anything is encoded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
  const { commands, tools } = stubTools({ sourceSizes: { "shot.mp4": [1280, 720] } });
  const manifestPath = await writeManifest(directory, baseManifest());

  await assert.rejects(
    assembleMaster(manifestPath, { workspaceRoot: directory, tools }),
    /Segment hook source shot\.mp4 is 1280x720 \(16:9\).*master is 720x1280 \(9:16\).*Declare output\.fit/s,
  );
  assert.deepEqual(commands, [], "nothing is encoded before the shapes agree");
});

test("declaring fit is what makes a mixed-ratio cut buildable, and each mode is a different filter", async () => {
  const expected = {
    pad: /scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:\(ow-iw\)\/2:\(oh-ih\)\/2,setsar=1/,
    cover: /scale=720:1280:force_original_aspect_ratio=increase:force_divisible_by=2,crop=720:1280,setsar=1/,
    stretch: /scale=720:1280,setsar=1/,
  };

  for (const [fit, pattern] of Object.entries(expected)) {
    const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
    const { commands, tools } = stubTools({ sourceSizes: { "shot.mp4": [1280, 720] } });
    await assembleMaster(
      await writeManifest(
        directory,
        baseManifest({ output: { masters_root: "masters", fit } }),
      ),
      { workspaceRoot: directory, tools },
    );

    const clip = commands.find((command) => command.includes("hook-v1.mov"));
    assert.match(clip, pattern, `${fit} builds its own geometry`);
  }
});

test("a per-segment fit overrides the output default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
  const { commands, tools } = stubTools({ sourceSizes: { "shot.mp4": [1280, 720] } });
  await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        output: { masters_root: "masters", fit: "pad" },
        segments: [
          { id: "hook", kind: "clip", source: "shot.mp4", frames: 96, audio: "silent", fit: "cover" },
          { id: "cards", kind: "still", source: "card.png", frames: 96 },
        ],
      }),
    ),
    { workspaceRoot: directory, tools },
  );

  assert.match(
    commands.find((command) => command.includes("hook-v1.mov")),
    /force_original_aspect_ratio=increase/,
  );
  assert.match(
    commands.find((command) => command.includes("cards-v1.mov")),
    /force_original_aspect_ratio=decrease/,
  );
});

test("a scrolling still is exempt: it is fed an over-tall source on purpose", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
  const { commands, tools } = stubTools({ sourceSizes: { "card.png": [720, 3000] } });
  await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({
        segments: [
          { id: "hook", kind: "clip", source: "shot.mp4", frames: 96, audio: "silent" },
          { id: "cards", kind: "still", source: "card.png", frames: 96, motion: { type: "scroll", to_y: 1720 } },
        ],
      }),
    ),
    { workspaceRoot: directory, tools },
  );

  const still = commands.find((command) => command.includes("cards-v1.mov"));
  assert.match(still, /crop=720:1280:0:/);
  assert.doesNotMatch(still, /force_original_aspect_ratio/);
});

/** A frozen plan next to the masters root the manifest points at. */
async function writeFrozenPlan(directory, target) {
  const briefRoot = join(directory, "projects", "acme", "V001", "brief");
  await mkdir(briefRoot, { recursive: true });
  await writeFile(
    join(briefRoot, "shotplan.json"),
    JSON.stringify({ project_id: "ACME-V001", status: "frozen", target }),
    "utf8",
  );
}

test("a master that disagrees with the frozen plan is reported, and blocks under --require-review", async () => {
  const projectManifest = baseManifest({
    output: { masters_root: "artifacts/acme/V001/masters", width: 720, height: 1280 },
  });

  for (const [requireReview, bucket] of [[false, "warnings"], [true, "issues"]]) {
    const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
    await writeFrozenPlan(directory, { aspect_ratio: "16:9", frame_rate: 24 });
    const { tools } = stubTools();
    const report = await assembleMaster(await writeManifest(directory, projectManifest), {
      workspaceRoot: directory,
      tools,
      requireReview,
    });

    assert.ok(
      report.verification[bucket].some((entry) =>
        /master_aspect_ratio_off_plan: plan 16:9, master 9:16 \(720x1280\)/.test(entry),
      ),
      `plan disagreement lands in ${bucket}`,
    );
  }
});

test("a master that matches the frozen plan says nothing about it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-assembly-"));
  await writeFrozenPlan(directory, { aspect_ratio: "9:16", frame_rate: 24 });
  const { tools } = stubTools();
  const report = await assembleMaster(
    await writeManifest(
      directory,
      baseManifest({ output: { masters_root: "artifacts/acme/V001/masters" } }),
    ),
    { workspaceRoot: directory, tools, requireReview: true },
  );

  const mentions = [...report.verification.issues, ...report.verification.warnings].filter((entry) =>
    /off_plan/.test(entry),
  );
  assert.deepEqual(mentions, []);
});
