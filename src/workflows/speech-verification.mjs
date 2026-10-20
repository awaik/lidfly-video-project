import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redact } from "../core/errors.mjs";
import { compareSpeech, nativeAudioStatusFrom } from "../domain/speech-match.mjs";
import { probeMedia, runFfmpeg } from "../media/ffmpeg.mjs";
import { KomendClient } from "../providers/komend/client.mjs";
import { loadVideoJob } from "./video-job.mjs";

/**
 * The line a take was asked to deliver.
 *
 * metadata.dialogue_ru is where the production workflow records spoken copy for
 * a shot; narration.text is the separate narration path. Either is a valid
 * source of truth, but one of them has to exist before a transcript means anything.
 */
export function expectedSpeechFrom(request) {
  const dialogue = request?.metadata?.dialogue_ru;
  if (typeof dialogue === "string" && dialogue.trim()) return { text: dialogue, source: "metadata.dialogue_ru" };
  const narration = request?.narration?.text;
  if (typeof narration === "string" && narration.trim()) return { text: narration, source: "narration.text" };
  return null;
}

/**
 * Check a generated take's native speech against the line it was asked to say.
 *
 * This is what the QA rubric has always required ("transcribe required speech
 * and compare it with the approved text") and what the Komend TTS gate depends
 * on — until now the status was typed in by hand.
 */
export async function verifyJobSpeech(
  jobDirectory,
  { client = null, tools = { runFfmpeg, probeMedia }, now = new Date() } = {},
) {
  const job = await loadVideoJob(resolve(jobDirectory));
  const expected = expectedSpeechFrom(job.request);
  if (!expected) {
    throw new Error(
      "This job declares no spoken line (metadata.dialogue_ru or narration.text), so there is nothing to verify against",
    );
  }

  const output = job.state.outputs?.[0];
  if (!output) throw new Error("Job has no downloaded output to verify");

  const media = await tools.probeMedia(output);
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  if (!media.audio) {
    // No audio stream at all is a legitimate, recordable answer: it is exactly
    // the "native narration missing" case the TTS gate is waiting for.
    const report = {
      schema_version: 1,
      job_directory: job.jobDirectory,
      shot_id: job.request.shot_id,
      take_id: job.request.take_id,
      expected_text: expected.text,
      expected_source: expected.source,
      transcript: null,
      comparison: { status: "missing", similarity: 0, note: "the take carries no audio stream" },
      native_audio_status: "missing",
      verified_at: now.toISOString(),
    };
    return writeReport(job.jobDirectory, stamp, report);
  }

  // Mono 16 kHz is what recognizers expect and keeps the upload small.
  const audioPath = join(job.jobDirectory, "outputs", `speech-${stamp}.wav`);
  await mkdir(join(job.jobDirectory, "outputs"), { recursive: true });
  await tools.runFfmpeg(["-i", output, "-vn", "-ac", "1", "-ar", "16000", audioPath]);

  const providerClient = client ?? new KomendClient();
  const transcription = await providerClient.transcribe({ audioPath, language: "ru" });
  const comparison = compareSpeech(expected.text, transcription.text);

  return writeReport(job.jobDirectory, stamp, {
    schema_version: 1,
    job_directory: job.jobDirectory,
    shot_id: job.request.shot_id,
    take_id: job.request.take_id,
    expected_text: expected.text,
    expected_source: expected.source,
    transcript: redact(transcription),
    audio_path: audioPath,
    comparison,
    native_audio_status: nativeAudioStatusFrom(comparison),
    verified_at: now.toISOString(),
  });
}

async function writeReport(jobDirectory, stamp, report) {
  const path = join(jobDirectory, `speech-verification-${stamp}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { ...report, report_path: path };
}

/**
 * The most recent verification recorded for a job, so the TTS gate can read the
 * native-audio status instead of trusting a hand-typed flag.
 */
export async function latestSpeechVerification(jobDirectory) {
  const directory = resolve(jobDirectory);
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const reports = entries.filter((name) => /^speech-verification-.*\.json$/.test(name)).sort();
  if (reports.length === 0) return null;
  return JSON.parse(await readFile(join(directory, reports.at(-1)), "utf8"));
}
