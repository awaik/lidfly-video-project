import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { shouldUseExternalNarration } from "../domain/video-request.mjs";
import { KomendClient } from "../providers/komend/client.mjs";
import { loadVideoJob } from "./video-job.mjs";

export async function synthesizeJobNarration(
  jobDirectory,
  {
    execute = false,
    nativeAudioStatus,
    format = "mp3",
    client = null,
    now = new Date(),
    attemptId = randomUUID().replaceAll("-", "").slice(0, 12),
  } = {},
) {
  if (!execute) throw new Error("Komend TTS requires explicit execute=true / --execute");
  if (!["mp3", "wav"].includes(format)) throw new TypeError("format must be one of: mp3, wav");

  const job = await loadVideoJob(resolve(jobDirectory));
  if (!shouldUseExternalNarration({ narration: job.request.narration, nativeAudioStatus })) {
    throw new Error(
      "Komend TTS is allowed only when narration exists and native audio status is missing or unusable",
    );
  }

  const stamp = now.getTime();
  const artifactId = `${stamp}-${attemptId}`;
  const outputPath = join(job.jobDirectory, "outputs", `narration-${artifactId}.${format}`);
  const providerClient = client ?? new KomendClient();
  const result = await providerClient.synthesize({
    text: job.request.narration.text,
    voice: job.request.narration.voice,
    format,
    outputPath,
  });
  const manifest = {
    ...result,
    native_audio_status: nativeAudioStatus,
    text_sha256: createHash("sha256").update(job.request.narration.text).digest("hex"),
    created_at: now.toISOString(),
  };
  const manifestPath = join(job.jobDirectory, `tts-${artifactId}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { jobDirectory: job.jobDirectory, result, manifest, manifestPath };
}
