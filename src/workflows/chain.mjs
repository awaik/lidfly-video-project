import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hashFile } from "../core/hashing.mjs";
import { exists } from "../core/workspace-files.mjs";
import { normalizeReviewRecord } from "../domain/review-record.mjs";
import { extractFrame } from "../media/ffmpeg.mjs";
import { loadVideoJob } from "./video-job.mjs";

/**
 * Prepare a request that starts from the last frame of an accepted take.
 *
 * This is the cheapest defence against the world drifting between shots: the
 * next clip literally begins where the previous one ended. Like retry, it only
 * writes a request file — planning and paying stay separate, explicit steps.
 */
export async function prepareChainedRequest({
  fromJobDirectory,
  requestPath,
  position = "last",
  reviewPath = null,
  tools = { extractFrame },
  now = new Date(),
}) {
  const job = await loadVideoJob(resolve(fromJobDirectory));
  if (job.state.phase !== "completed") {
    throw new Error(`Source job is "${job.state.phase}"; chain from a completed take only`);
  }
  const output = job.state.outputs?.[0];
  if (!output) throw new Error("Source job has no downloaded output to chain from");

  // Chaining from a take nobody accepted would multiply its defects across the
  // rest of the film.
  const review = reviewPath
    ? normalizeReviewRecord(JSON.parse(await readFile(resolve(reviewPath), "utf8")), "review record")
    : null;
  if (!review) {
    throw new Error(
      "Chaining requires the review that accepted the source take: pass --review <path to the review json>",
    );
  }
  if (!review.accepts) {
    throw new Error(`Source take was not accepted (decision "${review.decision}"); chain from an accepted take`);
  }

  const framePath =
    job.state.frames?.[0]?.[`${position}_frame`] ??
    (await tools.extractFrame(output, output.replace(/\.[^.]+$/, `-${position}.png`), { position }));

  const target = resolve(requestPath);
  if (await exists(target)) throw new Error(`Request file already exists: ${target}`);

  const request = {
    schema_version: 1,
    shot_id: null,
    take_id: "T001",
    provider: "evolink",
    model: job.request.model,
    // A start frame only means something in a mode that accepts one.
    mode: "image_to_video",
    prompt: "",
    duration_seconds: job.request.duration_seconds,
    aspect_ratio: job.request.aspect_ratio,
    resolution: job.request.resolution,
    generate_audio: job.request.generate_audio,
    references: [
      {
        asset_id: `${job.request.shot_id}-${job.request.take_id}-${position}-frame`.toLowerCase(),
        role: "start_frame",
        path: framePath,
        rights_status: "not_required",
      },
    ],
    options: {},
    metadata: {
      ...(job.request.metadata?.production ? { production: job.request.metadata.production } : {}),
      continuity: {
        from_job_directory: job.jobDirectory,
        from_shot_id: job.request.shot_id,
        from_take_id: job.request.take_id,
        from_output: output,
        frame: position,
        frame_sha256: await hashFile(framePath),
        review: resolve(reviewPath),
        prepared_at: now.toISOString(),
      },
    },
  };

  await writeFile(target, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    request_path: target,
    frame_path: framePath,
    from_shot_id: job.request.shot_id,
    from_take_id: job.request.take_id,
    next_step: `Впишите shot_id и prompt в ${basename(target)}, затем node src/cli.mjs plan --request ${target}`,
    caution:
      "Последний кадр 720p-тейка имеет короткую сторону 720px — ниже рекомендованных 1024. Цепочка из пяти-шести шотов накапливает дрейф: периодически возвращайтесь к исходному identity-референсу.",
  };
}

/** Save the first and last frame of an already downloaded take. */
export async function extractJobFrames(jobDirectory, { tools = { extractFrame } } = {}) {
  const job = await loadVideoJob(resolve(jobDirectory));
  const outputs = job.state.outputs ?? [];
  if (outputs.length === 0) throw new Error("Job has no downloaded output to extract frames from");

  const frames = [];
  for (const output of outputs) {
    const entry = { output };
    for (const position of ["first", "last"]) {
      const target = join(dirname(output), basename(output).replace(/\.[^.]+$/, `-${position}.png`));
      entry[`${position}_frame`] = await tools.extractFrame(output, target, { position });
    }
    frames.push(entry);
  }
  return { job_directory: job.jobDirectory, frames };
}
