import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findJobs } from "./retry.mjs";
import { planVideoJob, waitForVideoJob } from "./video-job.mjs";

const FINISHED_PHASES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "submission_rejected",
  "submission_lost",
]);

/**
 * Plan every request file in a directory.
 *
 * Safe to repeat: planning is free and idempotent by request hash, so a rerun
 * returns the same job directories instead of creating new ones. One bad file
 * does not stop the rest — the failures are reported per file.
 */
export async function planRequestDirectory(directory, { jobsRoot, now = new Date() } = {}) {
  const root = resolve(directory);
  const names = (await readdir(root))
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort();

  const results = [];
  let planned = 0;
  let reused = 0;
  let failed = 0;
  let estimatedUsd = 0;
  let unknownRate = 0;

  for (const name of names) {
    const requestPath = join(root, name);
    try {
      const raw = JSON.parse(await readFile(requestPath, "utf8"));
      const job = await planVideoJob(raw, { requestSource: requestPath, jobsRoot, now });
      const estimate = job.state.cost_estimate;
      if (estimate?.status === "estimated") estimatedUsd += estimate.usd;
      else unknownRate += 1;
      if (job.reused) reused += 1;
      else planned += 1;
      results.push({
        request_path: requestPath,
        job_directory: job.jobDirectory,
        shot_id: job.request.shot_id,
        take_id: job.request.take_id,
        reused: job.reused,
        estimated_usd: estimate?.status === "estimated" ? estimate.usd : null,
      });
    } catch (error) {
      failed += 1;
      results.push({ request_path: requestPath, error: String(error?.message ?? error) });
    }
  }

  return {
    requests_root: root,
    jobs_root: resolve(jobsRoot),
    count: names.length,
    planned,
    reused,
    failed,
    // The price of the whole batch, so the decision to submit is made with the
    // total in view rather than one job at a time.
    total_estimated_usd: Math.round(estimatedUsd * 1e6) / 1e6,
    ...(unknownRate ? { routes_without_measured_price: unknownRate } : {}),
    results,
  };
}

/**
 * Wait for every unfinished job under a jobs root, one after another.
 *
 * Sequential on purpose: the tasks already run in parallel on the provider side,
 * so total wall clock is roughly the slowest job either way, and a shared
 * deadline stays easy to reason about.
 */
export async function waitForJobsRoot(jobsRoot, { client = null, timeoutMs = 900_000, download = true } = {}) {
  const listing = await findJobs(jobsRoot, {});
  const pending = listing.jobs.filter((job) => !FINISHED_PHASES.has(job.phase));
  const deadline = Date.now() + timeoutMs;

  const results = [];
  for (const job of pending) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ job_directory: job.job_directory, status: "skipped", reason: "batch timeout reached" });
      continue;
    }
    try {
      const finished = await waitForVideoJob(job.job_directory, {
        ...(client ? { client } : {}),
        timeoutMs: remaining,
        download,
      });
      results.push({
        job_directory: job.job_directory,
        shot_id: finished.request.shot_id,
        take_id: finished.request.take_id,
        status: finished.state.phase,
        outputs: finished.outputs,
      });
    } catch (error) {
      results.push({
        job_directory: job.job_directory,
        status: "failed",
        error: String(error?.message ?? error),
      });
    }
  }

  return {
    jobs_root: resolve(jobsRoot),
    considered: listing.count,
    waited: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
}
