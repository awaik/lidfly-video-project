import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { synthesizeJobNarration } from "../src/workflows/narration.mjs";
import { planVideoJob } from "../src/workflows/video-job.mjs";

function requestWithNarration() {
  return {
    schema_version: 1,
    shot_id: "S200",
    take_id: "T001",
    provider: "evolink",
    model: "kling-v3",
    mode: "text_to_video",
    prompt: "A stable vertical shot",
    duration_seconds: 5,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
    references: [],
    options: {},
    narration: { text: "Это проверка.", language: "ru", voice: "female" },
  };
}

async function planNarratedJob() {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-narration-"));
  const source = join(directory, "request.json");
  const request = requestWithNarration();
  await writeFile(source, JSON.stringify(request), "utf8");
  return planVideoJob(request, { requestSource: source, jobsRoot: join(directory, "jobs") });
}

test("narration workflow enforces execute and reviewed native-audio gates", async () => {
  const plan = await planNarratedJob();
  let synthesisCalls = 0;
  const client = { async synthesize() { synthesisCalls += 1; } };
  await assert.rejects(
    synthesizeJobNarration(plan.jobDirectory, {
      execute: false,
      nativeAudioStatus: "missing",
      client,
    }),
    /requires explicit execute=true/,
  );
  await assert.rejects(
    synthesizeJobNarration(plan.jobDirectory, {
      execute: true,
      nativeAudioStatus: "present",
      client,
    }),
    /native audio status is missing or unusable/,
  );
  assert.equal(synthesisCalls, 0);
});

test("narration workflow writes a unique provenance manifest", async () => {
  const plan = await planNarratedJob();
  const client = {
    async synthesize({ text, voice, format, outputPath }) {
      return {
        provider: "komend",
        model: "v5_cis_base_nostress",
        voice_id: voice,
        format,
        text_length: text.length,
        output_path: outputPath,
      };
    },
  };
  const result = await synthesizeJobNarration(plan.jobDirectory, {
    execute: true,
    nativeAudioStatus: "missing",
    client,
    now: new Date("2026-08-05T12:00:00.000Z"),
    attemptId: "testattempt01",
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.native_audio_status, "missing");
  assert.equal(manifest.text_sha256.length, 64);
  assert.equal(manifest.created_at, "2026-08-05T12:00:00.000Z");
  assert.match(result.manifestPath, /tts-1785931200000-testattempt01\.json$/);
});
