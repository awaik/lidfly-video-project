import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { measureBandEnvelope } from "../media/ffmpeg.mjs";
import { scoreSpeechLikeness } from "../domain/speech-likeness.mjs";
import { loadVideoJob } from "./video-job.mjs";

const SPEECH_BAND = { highpassHz: 300, lowpassHz: 3400 };

/**
 * Flag a take that seems to contain speech nobody asked for.
 *
 * Deliberately separate from verify-speech: this never writes
 * native_audio_status and never unlocks paid TTS. It only says "listen to this".
 */
export async function detectJobSpeechSignal(
  jobDirectory,
  { tools = { measureBandEnvelope }, now = new Date() } = {},
) {
  const job = await loadVideoJob(jobDirectory);
  const outputs = job.state.outputs ?? [];
  if (outputs.length === 0) throw new Error("Job has no downloaded output to inspect");

  const results = [];
  for (const output of outputs) {
    const full = await tools.measureBandEnvelope(output, { windowSeconds: 0.05 });
    const band = await tools.measureBandEnvelope(output, { windowSeconds: 0.05, ...SPEECH_BAND });
    const score = scoreSpeechLikeness({
      fullDb: full.windows,
      speechDb: band.windows,
      windowSeconds: full.window_seconds,
    });
    results.push({ output, ...score });
  }

  const dialogueRequested = Boolean(job.request.metadata?.dialogue_ru || job.request.narration?.text);
  const anySpeech = results.some((result) => result.verdict === "speech_likely");
  const report = {
    schema_version: 1,
    shot_id: job.request.shot_id,
    take_id: job.request.take_id,
    job_directory: job.jobDirectory,
    generate_audio: job.request.generate_audio,
    dialogue_requested: dialogueRequested,
    speech_signal: anySpeech
      ? "present"
      : results.every((result) => result.verdict === "speech_unlikely")
        ? "absent"
        : "inconclusive",
    // The case worth catching: audio was generated, no line was written, and
    // something in the clip still sounds like talking.
    unexpected_speech: anySpeech && !dialogueRequested,
    method:
      "RMS envelope in 50 ms windows, full band against 300-3400 Hz, with syllable-rate modulation. Not speech recognition.",
    limitations: [
      "Измерено на девяти тейках этого репозитория: речь поймана 3/3, ложных срабатываний 2/6 (серии металлических ударов читаются как чередование слогов)",
      "Ложные срабатывания: удары, рык, вокал в музыке, гул толпы",
      "Пропуски: шёпот, сильно приглушённый голос, речь под громкой музыкой",
      "На четырёхсекундном клипе статистики мало, результат шумит",
      "Не заменяет verify-speech: содержание реплики этим способом не проверяется",
    ],
    outputs: results,
    checked_at: now.toISOString(),
  };

  const path = join(job.jobDirectory, `speech-likeness-${now.toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { ...report, report_path: path };
}
