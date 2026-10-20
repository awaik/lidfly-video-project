import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { redact } from "../core/errors.mjs";
import { stableJson } from "../core/hashing.mjs";
import { formatVideoDirectory, productionMetadata } from "../domain/production-context.mjs";
import { normalizeVideoRequest } from "../domain/video-request.mjs";
import { extractFrame } from "../media/ffmpeg.mjs";
import { EvolinkClient } from "../providers/evolink/client.mjs";
import {
  buildEvolinkPayload,
  estimateJobCost,
  referenceFileLimits,
} from "../providers/evolink/model-catalog.mjs";
import {
  assertBudgetAllows,
  jobsRootFromJobDirectory,
  projectPathsFromJobsRoot,
} from "./budget.mjs";
import { assertShotPlanAllows } from "./shot-plan-gate.mjs";

export { stableJson };

export function requestHash(request) {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

async function writeJson(path, value, options = {}) {
  await writeFile(path, stableJson(value), { encoding: "utf8", ...options });
}

async function writeJsonOnce(path, value) {
  try {
    await writeJson(path, value, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(path);
    if (stableJson(existing) !== stableJson(value)) {
      throw new Error(`Immutable manifest already exists with different content: ${path}`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function placeholderReferenceUrls(request) {
  return Object.fromEntries(
    request.references.map((reference) => [
      reference.asset_id,
      reference.url ?? `upload-required://${reference.asset_id}`,
    ]),
  );
}

async function hashLocalReferences(request) {
  const output = [];
  for (const reference of request.references) {
    if (!reference.path) {
      output.push({
        ...reference,
        locator_sha256: createHash("sha256").update(reference.url).digest("hex"),
      });
      continue;
    }
    const info = await stat(reference.path);
    if (!info.isFile()) throw new TypeError(`Reference is not a file: ${reference.path}`);
    const { max_bytes: maxBytes } = referenceFileLimits(request.model);
    if (info.size > maxBytes) {
      throw new RangeError(`Reference image exceeds ${maxBytes / 1024 / 1024}MB: ${reference.path}`);
    }
    const contents = await readFile(reference.path);
    output.push({
      ...reference,
      sha256: createHash("sha256").update(contents).digest("hex"),
      size_bytes: info.size,
    });
  }
  return { ...request, references: output };
}

function validateLocalImageCompatibility(request) {
  for (const reference of request.references.filter((item) => item.path)) {
    const extension = extname(reference.path).toLowerCase();
    const allowed = referenceFileLimits(request.model).extensions;
    if (!allowed.includes(extension)) {
      throw new TypeError(`${request.model} does not support local reference format ${extension}`);
    }
  }
}

function validateProductionPlanBinding(request, jobsRoot) {
  const production = request.metadata?.production;
  const normalizedJobsRoot = resolve(jobsRoot).split(sep).join("/");
  // Same parser the budget gate uses, so planning and submission agree on what
  // counts as a project-specific jobs root.
  const projectJobsMatch = projectPathsFromJobsRoot(jobsRoot);
  if (!production && !projectJobsMatch) return;
  if (!production) {
    throw new TypeError(
      "metadata.production is required when planning into a project-specific artifacts/<client>/VNNN/jobs root",
    );
  }

  const normalized = productionMetadata(production).production;
  const expectedSuffix = `/artifacts/${normalized.client_id}/${formatVideoDirectory(normalized.video_number)}/jobs`;
  if (!normalizedJobsRoot.endsWith(expectedSuffix)) {
    throw new TypeError(
      `jobsRoot does not match metadata.production; expected a path ending in ${expectedSuffix}`,
    );
  }
}

export async function planVideoJob(
  rawRequest,
  { requestSource, jobsRoot = "artifacts/jobs", now = new Date() } = {},
) {
  let request = normalizeVideoRequest(rawRequest);
  validateProductionPlanBinding(request, jobsRoot);
  // The plan gate runs before anything is written: a shot nobody reviewed should
  // not even get an immutable job directory.
  const scriptPlan = await assertShotPlanAllows({ jobsRoot, request });
  validateLocalImageCompatibility(request);
  request = await hashLocalReferences(request);
  const hash = requestHash(request);
  const jobDirectory = resolve(jobsRoot, request.shot_id, `${request.take_id}-${hash.slice(0, 12)}`);
  const jobStatePath = join(jobDirectory, "job.json");
  const providerPlan = buildEvolinkPayload(request, {
    referenceUrls: placeholderReferenceUrls(request),
  });
  const capabilitySnapshot = {
    provider: "evolink",
    requested_label: providerPlan.requested_label,
    upstream_family: providerPlan.upstream_family,
    resolved_model_id: providerPlan.resolved_model_id,
    endpoint: "POST https://api.evolink.ai/v1/videos/generations",
    source: providerPlan.capability_source,
    discovered_at: now.toISOString(),
  };
  const initialState = {
    schema_version: 1,
    phase: "planned",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    request_hash: hash,
    request_source: requestSource ? resolve(requestSource) : null,
    remote_task_id: null,
    provider: "evolink",
    resolved_model_id: providerPlan.resolved_model_id,
    uploads: {},
    paid_execution_started: false,
    cost_estimate: estimateJobCost(request),
    script_plan: scriptPlan,
  };

  await mkdir(jobDirectory, { recursive: true });
  if (await pathExists(jobStatePath)) {
    const existing = await readJson(jobStatePath);
    if (existing.request_hash !== hash) throw new Error(`Job directory collision: ${jobDirectory}`);
    return { jobDirectory, request, state: existing, capabilitySnapshot, reused: true };
  }
  await writeJson(join(jobDirectory, "normalized-request.json"), redact(request), { flag: "wx" });
  await writeJson(join(jobDirectory, "provider-payload.plan.json"), redact(providerPlan.payload), {
    flag: "wx",
  });
  await writeJson(join(jobDirectory, "capabilities.json"), capabilitySnapshot, { flag: "wx" });
  await writeJson(jobStatePath, initialState, { flag: "wx" });
  return { jobDirectory, request, state: initialState, capabilitySnapshot, reused: false };
}

export async function loadVideoJob(jobDirectory) {
  const directory = resolve(jobDirectory);
  return {
    jobDirectory: directory,
    state: await readJson(join(directory, "job.json")),
    request: await readJson(join(directory, "normalized-request.json")),
  };
}

/**
 * Write job state, append its snapshot to the journal, and never lose a step.
 * Exported so reconcile can record a state change through the same path.
 */
export async function persistJobState(jobDirectory, state) {
  return persistState(jobDirectory, state);
}

async function persistState(jobDirectory, state) {
  const next = { ...state, updated_at: new Date().toISOString() };
  const eventsDirectory = join(jobDirectory, "events");
  await mkdir(eventsDirectory, { recursive: true });
  const eventName = `${Date.now()}-${createHash("sha256").update(stableJson(next)).digest("hex").slice(0, 10)}.json`;
  await writeJsonOnce(join(eventsDirectory, eventName), next);
  await writeJson(join(jobDirectory, "job.json"), next);
  return next;
}

function stateChanged(current, next) {
  const { updated_at: _currentUpdatedAt, ...currentData } = current;
  const { updated_at: _nextUpdatedAt, ...nextData } = next;
  return stableJson(currentData) !== stableJson(nextData);
}

function snapshotName(prefix, value, now = Date.now()) {
  const hash = createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 10);
  return `${prefix}-${now}-${hash}.json`;
}

async function loadAndVerifySource(job) {
  if (!job.state.request_source) {
    throw new Error("This job has no request_source; submit programmatically with the original request");
  }
  const raw = await readJson(job.state.request_source);
  let request = normalizeVideoRequest(raw);
  validateLocalImageCompatibility(request);
  request = await hashLocalReferences(request);
  if (requestHash(request) !== job.state.request_hash) {
    throw new Error("Request source changed after planning; create a new take/job instead");
  }
  return request;
}

export async function submitVideoJob(
  jobDirectory,
  { execute = false, client = null } = {},
) {
  if (!execute) throw new Error("Paid EVOLINK submission requires explicit execute=true / --execute");
  const providerClient = client ?? new EvolinkClient();
  const job = await loadVideoJob(jobDirectory);
  if (job.state.remote_task_id) return { ...job, reused: true };
  if (["submission_started", "submission_unknown"].includes(job.state.phase)) {
    throw new Error(
      "Previous submission outcome is ambiguous; inspect EVOLINK before creating any new paid task",
    );
  }
  if (job.state.phase === "submission_rejected") {
    throw new Error("This immutable job was rejected; correct the request and create a new take/job");
  }
  if (job.state.phase === "submission_lost") {
    // Reconcile proved this job created no task. Retry must move to a new take
    // with its own directory, so this one can never be paid for twice.
    throw new Error(
      "This job's submission was reconciled as lost; create the next take with retry instead of resubmitting a paid job",
    );
  }

  const request = await loadAndVerifySource(job);
  // "You have no approved plan" is a more basic refusal than "you are out of
  // money", so the script gate answers first.
  const scriptPlan = await assertShotPlanAllows({
    jobsRoot: jobsRootFromJobDirectory(job.jobDirectory),
    request,
  });
  // The project manifest governs paid work. Checked before uploads, because
  // uploadImage() already talks to the provider.
  // The estimate is recomputed from the verified request rather than read from
  // job.json: jobs planned before pricing existed still carry the old placeholder,
  // and the gate must not treat a stale record as the current price.
  const budget = await assertBudgetAllows({
    jobsRoot: jobsRootFromJobDirectory(job.jobDirectory),
    request,
    estimate: estimateJobCost(request),
  });
  let state = job.state;
  const referenceUrls = {};
  for (const reference of request.references) {
    if (reference.url) {
      if (typeof providerClient.preflightUrl === "function") {
        await providerClient.preflightUrl(reference.url, reference.role);
      }
      referenceUrls[reference.asset_id] = reference.url;
      continue;
    }
    const existing = state.uploads?.[reference.asset_id];
    if (existing?.file_url) {
      referenceUrls[reference.asset_id] = existing.file_url;
      continue;
    }
    const upload = await providerClient.uploadImage(reference.path);
    state = await persistState(job.jobDirectory, {
      ...state,
      phase: "uploading_inputs",
      uploads: {
        ...state.uploads,
        [reference.asset_id]: {
          file_url: upload.file_url,
          file_id: upload.file_id,
          expires_at: upload.expires_at,
          source_sha256: reference.sha256,
        },
      },
    });
    referenceUrls[reference.asset_id] = upload.file_url;
  }

  const providerRequest = buildEvolinkPayload(request, { referenceUrls });
  await writeJsonOnce(
    join(job.jobDirectory, "provider-payload.submit.json"),
    redact(providerRequest.payload),
  );
  state = await persistState(job.jobDirectory, {
    ...state,
    phase: "submission_started",
    paid_execution_started: true,
    submission_started_at: new Date().toISOString(),
    script_plan: scriptPlan,
    budget,
  });

  try {
    const submitted = await providerClient.submitVideo(providerRequest.payload);
    await writeJson(join(job.jobDirectory, "provider-submit-response.json"), redact(submitted), {
      flag: "wx",
    });
    state = await persistState(job.jobDirectory, {
      ...state,
      phase: String(submitted.status ?? "pending"),
      remote_task_id: String(submitted.id),
      provider_model: submitted.model ?? providerRequest.resolved_model_id,
      usage: redact(submitted.usage ?? null),
    });
    return { jobDirectory: job.jobDirectory, state, request, submitted, reused: false };
  } catch (error) {
    const definitelyRejected = error?.status >= 400 && error?.status < 500 && error?.status !== 429;
    await persistState(job.jobDirectory, {
      ...state,
      phase: definitelyRejected ? "submission_rejected" : "submission_unknown",
      provider_error: {
        name: error?.name ?? "Error",
        message: String(error?.message ?? error),
        code: error?.code ?? null,
        status: error?.status ?? null,
      },
    });
    throw error;
  }
}

export async function refreshVideoJob(jobDirectory, { client = null } = {}) {
  const providerClient = client ?? new EvolinkClient();
  const job = await loadVideoJob(jobDirectory);
  if (!job.state.remote_task_id) throw new Error("Job has no EVOLINK task ID");
  const task = await providerClient.getTask(job.state.remote_task_id);
  const taskSnapshot = redact(task);
  await writeJsonOnce(join(job.jobDirectory, snapshotName("task", taskSnapshot)), taskSnapshot);
  const nextState = {
    ...job.state,
    phase: String(task.status ?? job.state.phase),
    progress: task.progress ?? null,
    provider_error: redact(task.error ?? null),
    usage: redact(task.usage ?? job.state.usage ?? null),
  };
  const state = stateChanged(job.state, nextState)
    ? await persistState(job.jobDirectory, nextState)
    : job.state;
  return { ...job, state, task };
}

export async function waitForVideoJob(
  jobDirectory,
  { client = null, timeoutMs = 900_000, download = true, extractFrames = true, tools = { extractFrame } } = {},
) {
  const providerClient = client ?? new EvolinkClient();
  let job = await loadVideoJob(jobDirectory);
  if (!job.state.remote_task_id) throw new Error("Job has no EVOLINK task ID");
  const task = await providerClient.waitForTask(job.state.remote_task_id, {
    timeoutMs,
    onUpdate: async (current) => {
      const nextState = {
        ...job.state,
        phase: String(current.status ?? job.state.phase),
        progress: current.progress ?? null,
        usage: redact(current.usage ?? job.state.usage ?? null),
        provider_error: redact(current.error ?? null),
      };
      if (stateChanged(job.state, nextState)) {
        job.state = await persistState(job.jobDirectory, nextState);
      }
    },
  });
  const taskSnapshot = redact(task);
  await writeJsonOnce(
    join(job.jobDirectory, snapshotName("task-completed", taskSnapshot)),
    taskSnapshot,
  );
  const outputs = [];
  if (download) {
    if (!Array.isArray(task.results) || task.results.length === 0) {
      throw new Error("EVOLINK completed the task without result URLs");
    }
    for (let index = 0; index < task.results.length; index += 1) {
      outputs.push(
        await providerClient.downloadResult(task.results[index], join(job.jobDirectory, "outputs"), {
          index: index + 1,
        }),
      );
    }
  }
  // The first and last frame of every take: material for review, and the input
  // for chaining the next shot. Never fatal — the downloaded mp4 is the only
  // thing that was paid for, and it must not be lost to a frame extraction.
  const frames = [];
  if (download && extractFrames) {
    for (const output of outputs) {
      const entry = { output };
      for (const position of ["first", "last"]) {
        const target = output.replace(/\.[^.]+$/, `-${position}.png`);
        try {
          entry[`${position}_frame`] = await tools.extractFrame(output, target, { position });
        } catch (error) {
          entry[`${position}_frame_error`] = String(error?.message ?? error);
        }
      }
      frames.push(entry);
    }
  }

  job.state = await persistState(job.jobDirectory, {
    ...job.state,
    phase: "completed",
    progress: 100,
    outputs,
    ...(frames.length ? { frames } : {}),
    review_status: "required",
  });
  return { ...job, task, outputs, frames };
}
