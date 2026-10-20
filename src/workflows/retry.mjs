import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { requiredString } from "../core/validation.mjs";
import { jobsRootFromJobDirectory } from "./budget.mjs";
import { loadVideoJob } from "./video-job.mjs";

/** Phases a job can retry from: the provider gave a final, unsuccessful answer. */
const RETRYABLE_PHASES = Object.freeze(["failed", "submission_rejected", "cancelled", "submission_lost"]);

/** Job directories are named "<take_id>-<12 hex of request hash>". */
const TAKE_FROM_DIRECTORY = /^(.*)-[0-9a-f]{12}$/;
const NUMBERED_TAKE = /^([A-Za-z]*)(\d+)$/;

function takeIdsInShot(entries) {
  return entries
    .map((entry) => TAKE_FROM_DIRECTORY.exec(entry)?.[1])
    .filter((value) => typeof value === "string");
}

/**
 * Next free take in the same shot, continuing the existing numbering.
 * Looks at every planned take, not just the failed one, so a retry never
 * collides with a take that was planned but never submitted.
 */
export function nextTakeId(currentTakeId, existingTakeIds) {
  const parsed = NUMBERED_TAKE.exec(currentTakeId);
  if (!parsed) {
    throw new Error(
      `Cannot derive the next take from "${currentTakeId}"; pass an explicit take id instead`,
    );
  }
  const [, prefix, digits] = parsed;
  const width = digits.length;
  const used = new Set(existingTakeIds);
  let candidate = Number(digits);
  let next;
  do {
    candidate += 1;
    next = `${prefix}${String(candidate).padStart(width, "0")}`;
  } while (used.has(next));
  return next;
}

function retryRequestPath(sourcePath, currentTakeId, takeId) {
  const directory = dirname(sourcePath);
  const name = basename(sourcePath);
  // S102-T001-seedance.json -> S102-T002-seedance.json
  const renamed = name.includes(`-${currentTakeId}-`)
    ? name.replace(`-${currentTakeId}-`, `-${takeId}-`)
    : name.replace(/(\.json)$/, `-${takeId}$1`);
  return join(directory, renamed);
}

/**
 * Clone a failed request as the next take, carrying the link to what failed and
 * why this attempt differs.
 *
 * Deliberately does NOT edit the prompt or run plan/submit: choosing the single
 * variable to change is the author's creative call, and keeping that manual is
 * what keeps "one changed variable per retry" visible in the record. This only
 * removes the bookkeeping — numbering the take and recording the lineage.
 */
export async function prepareRetry(jobDirectory, { change, takeId: requestedTakeId } = {}) {
  const describedChange = requiredString(change, "--change", { max: 1_000 });
  const job = await loadVideoJob(resolve(jobDirectory));

  if (!RETRYABLE_PHASES.includes(job.state.phase)) {
    throw new Error(
      `Job phase is "${job.state.phase}"; retry is for a job the provider finished unsuccessfully (${RETRYABLE_PHASES.join(", ")})`,
    );
  }
  if (!job.state.request_source) {
    throw new Error(
      "This job has no request_source, so there is no request file to clone; recreate the request programmatically",
    );
  }

  const jobsRoot = jobsRootFromJobDirectory(job.jobDirectory);
  const shotDirectory = join(jobsRoot, job.request.shot_id);
  const existing = takeIdsInShot(
    (await readdir(shotDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const takeId = requestedTakeId
    ? requiredString(requestedTakeId, "--take-id")
    : nextTakeId(job.request.take_id, existing);
  if (existing.includes(takeId)) {
    throw new Error(`Take ${takeId} already exists for ${job.request.shot_id}`);
  }

  // Clone the author's original request file, not the normalized copy, so
  // comments and field order the author chose survive the retry.
  const source = JSON.parse(await readFile(job.state.request_source, "utf8"));
  const providerError = job.state.provider_error ?? null;
  const retryRequest = {
    ...source,
    take_id: takeId,
    metadata: {
      ...(source.metadata ?? {}),
      retry_of: {
        job_directory: job.jobDirectory,
        take_id: job.request.take_id,
        phase: job.state.phase,
        ...(providerError?.code ? { provider_error_code: providerError.code } : {}),
        ...(providerError?.message ? { provider_error_message: providerError.message } : {}),
      },
      retry_change: describedChange,
    },
  };

  const outputPath = retryRequestPath(job.state.request_source, job.request.take_id, takeId);
  await writeFile(outputPath, `${JSON.stringify(retryRequest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return {
    retry_request_path: outputPath,
    shot_id: job.request.shot_id,
    take_id: takeId,
    retry_of: retryRequest.metadata.retry_of,
    retry_change: describedChange,
    next_step:
      "Edit the single variable you intend to change in this file, then run: video plan --request <this file> --jobs-root <project jobs root>",
  };
}

/**
 * Index the immutable job manifests so a shot can be found without listing
 * hash-named directories by hand. Read-only.
 */
export async function findJobs(jobsRoot, { shotId, phase, latest = false } = {}) {
  const root = resolve(jobsRoot);
  const jobs = [];
  const shotDirectories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !shotId || name === shotId);

  for (const shot of shotDirectories.sort()) {
    const takeDirectories = (await readdir(join(root, shot), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const takeDirectory of takeDirectories.sort()) {
      const directory = join(root, shot, takeDirectory);
      let state;
      try {
        state = JSON.parse(await readFile(join(directory, "job.json"), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (phase && state.phase !== phase) continue;
      jobs.push({
        shot_id: shot,
        take_id: TAKE_FROM_DIRECTORY.exec(takeDirectory)?.[1] ?? takeDirectory,
        phase: state.phase,
        model: state.resolved_model_id ?? null,
        cost_usd: state.usage?.cost?.usd ?? null,
        provider_error_code: state.provider_error?.code ?? null,
        updated_at: state.updated_at ?? state.created_at ?? null,
        job_directory: directory,
        outputs: state.outputs ?? [],
      });
    }
  }

  jobs.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  const selected = latest ? jobs.slice(-1) : jobs;
  return {
    jobs_root: root,
    count: selected.length,
    charged_usd: Math.round(jobs.reduce((sum, job) => sum + (job.cost_usd ?? 0), 0) * 1e6) / 1e6,
    jobs: selected,
  };
}
