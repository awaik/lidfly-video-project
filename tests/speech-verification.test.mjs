import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareSpeech,
  nativeAudioStatusFrom,
  normalizeSpokenText,
} from "../src/domain/speech-match.mjs";
import {
  expectedSpeechFrom,
  latestSpeechVerification,
  verifyJobSpeech,
} from "../src/workflows/speech-verification.mjs";
import { planVideoJob } from "../src/workflows/video-job.mjs";

// Sample Russian line used to grade speech verification.
const LINE = "А-о, смотрите! Я отдала свой Директ нейросети!";

function rawRequest(overrides = {}) {
  return {
    schema_version: 1,
    shot_id: "S101",
    take_id: "T001",
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "Она идёт по набережной и говорит в камеру",
    duration_seconds: 4,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
    references: [],
    options: {},
    metadata: { dialogue_ru: LINE },
    ...overrides,
  };
}

async function jobWithOutput(directory, { request = rawRequest(), hasAudio = true } = {}) {
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(request), "utf8");
  const plan = await planVideoJob(request, { requestSource: source, jobsRoot: join(directory, "jobs") });
  const statePath = join(plan.jobDirectory, "job.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    JSON.stringify({
      ...state,
      phase: "completed",
      outputs: [join(plan.jobDirectory, "outputs", "result-01.mp4")],
    }),
    "utf8",
  );
  return {
    jobDirectory: plan.jobDirectory,
    tools: {
      async runFfmpeg(args) {
        await writeFile(args.at(-1), "stub-audio", "utf8");
      },
      async probeMedia() {
        return {
          duration_seconds: 4,
          video: { width: 720, height: 1280, frame_rate: 24 },
          audio: hasAudio ? { codec: "aac", sample_rate: 32_000, channels: 2 } : null,
        };
      },
    },
  };
}

test("formatting differences do not count as speech drift", () => {
  assert.deepEqual(normalizeSpokenText("Всё, ещё раз: «Директ»!"), ["все", "еще", "раз", "директ"]);
  // Same words, different punctuation and case.
  assert.equal(compareSpeech(LINE, "а о смотрите я отдала свой директ нейросети").status, "ok");
});

test("a transcript is graded against the line the model was asked to say", () => {
  const exact = compareSpeech(LINE, LINE);
  assert.equal(exact.status, "ok");
  assert.equal(exact.similarity, 1);

  // One word off out of nine still reads as the same line.
  const drifted = compareSpeech(LINE, "А-о, смотрите! Я отдала свой Директ нейросетям!");
  assert.equal(drifted.status, "ok");

  // The opening survives but the tail was improvised: recognisable, and a human
  // has to listen before this ships.
  const partial = compareSpeech(LINE, "А-о, смотрите! Я отдала свой Директ какому-то сервису");
  assert.equal(partial.status, "partial");
  assert.ok(partial.similarity > 0.5 && partial.similarity < 0.8, `similarity ${partial.similarity}`);
  assert.match(partial.note, /listen before accepting/);

  // Wrong copy entirely — this is what must never pass as usable.
  const wrong = compareSpeech(LINE, "Добрый день, сегодня отличная погода в Петербурге");
  assert.equal(wrong.status, "unusable");

  const silent = compareSpeech(LINE, "   ");
  assert.equal(silent.status, "missing");
  assert.equal(silent.similarity, 0);

  assert.throws(() => compareSpeech("", "что-то"), /expected speech text is required/);
});

test("only a clean match authorizes keeping native audio", () => {
  assert.equal(nativeAudioStatusFrom({ status: "ok" }), "usable");
  assert.equal(nativeAudioStatusFrom({ status: "missing" }), "missing");
  // A doubtful take must not quietly authorize a second synthesized voice
  // without being marked unusable first.
  assert.equal(nativeAudioStatusFrom({ status: "partial" }), "unusable");
  assert.equal(nativeAudioStatusFrom({ status: "unusable" }), "unusable");
});

test("the scripted line is read from where production actually records it", () => {
  assert.deepEqual(expectedSpeechFrom(rawRequest()), { text: LINE, source: "metadata.dialogue_ru" });
  assert.deepEqual(
    expectedSpeechFrom({ narration: { text: "Закадровый текст" } }),
    { text: "Закадровый текст", source: "narration.text" },
  );
  assert.equal(expectedSpeechFrom({ metadata: {} }), null);
});

test("verification transcribes the take and records the comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-speech-"));
  const { jobDirectory, tools } = await jobWithOutput(directory);

  const report = await verifyJobSpeech(jobDirectory, {
    tools,
    client: {
      async transcribe({ audioPath, language }) {
        assert.match(audioPath, /speech-.*\.wav$/);
        assert.equal(language, "ru");
        return { provider: "komend", text: LINE, language };
      },
    },
  });

  assert.equal(report.comparison.status, "ok");
  assert.equal(report.native_audio_status, "usable");
  assert.equal(report.expected_source, "metadata.dialogue_ru");

  const persisted = await latestSpeechVerification(jobDirectory);
  assert.equal(persisted.transcript.text, LINE);
  assert.equal(persisted.shot_id, "S101");
});

test("a take with no audio stream is recorded as missing without calling the recognizer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-speech-silent-"));
  const { jobDirectory, tools } = await jobWithOutput(directory, { hasAudio: false });

  const report = await verifyJobSpeech(jobDirectory, {
    tools,
    client: {
      async transcribe() {
        throw new Error("the recognizer must not be called when there is no audio");
      },
    },
  });

  assert.equal(report.comparison.status, "missing");
  assert.equal(report.native_audio_status, "missing");
  assert.match(report.comparison.note, /no audio stream/);
});

test("a take with no scripted line cannot be verified against anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-speech-noline-"));
  const { jobDirectory, tools } = await jobWithOutput(directory, {
    request: rawRequest({ metadata: { edit_purpose: "HOOK" } }),
  });

  await assert.rejects(
    verifyJobSpeech(jobDirectory, { tools, client: {} }),
    /declares no spoken line/,
  );
});

test("no verification report yet reads as null rather than throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-speech-empty-"));
  assert.equal(await latestSpeechVerification(directory), null);
  assert.equal(await latestSpeechVerification(join(directory, "missing")), null);
});
