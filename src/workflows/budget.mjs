import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  assertProjectIdentity,
  formatVideoDirectory,
  productionMetadata,
  validateProjectManifest,
} from "../domain/production-context.mjs";
import { estimateJobCost } from "../providers/evolink/model-catalog.mjs";

/**
 * A project-specific jobs root, as created by the production bootstrap:
 * <workspace>/artifacts/<client_id>/V<NNN>/jobs
 * The video number is padded to at least three digits and may grow beyond that,
 * so the pattern must stay in sync with formatVideoDirectory().
 */
// A job in these phases is not holding any provider money: it was never
// submitted, the provider refused it outright, or reconcile proved against the
// provider's own task list that no task was ever created.
const NON_RESERVING_PHASES = new Set(["planned", "submission_rejected", "submission_lost"]);

const PROJECT_JOBS_ROOT_PATTERN =
  /\/artifacts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(V\d{3,6})\/jobs$/;
const PROJECT_MASTERS_ROOT_PATTERN =
  /\/artifacts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(V\d{3,6})\/masters$/;

function posixPath(value) {
  return resolve(value).split(sep).join("/");
}

/**
 * Resolve the registry manifest that governs a project-specific jobs root.
 * Returns null for a shared or ad-hoc jobs root, which no project budget governs.
 *
 * The registry path (projects/<client>/VNNN/project.json) is used rather than
 * storage.project_root because it stays stable for legacy_alias projects too.
 */
export function projectPathsFromJobsRoot(jobsRoot) {
  const normalized = posixPath(jobsRoot);
  const match = PROJECT_JOBS_ROOT_PATTERN.exec(normalized);
  if (!match) return null;
  const [suffix, clientId, videoDirectory] = [match[0], match[1], match[2]];
  const workspaceRoot = normalized.slice(0, normalized.length - suffix.length);
  const projectRegistryRoot = `${workspaceRoot}/projects/${clientId}/${videoDirectory}`;
  return {
    workspaceRoot,
    clientId,
    videoDirectory,
    // One answer to "which project owns this jobs root", shared by planning, the
    // budget gate and the shot-plan gate. Two answers would be a hole.
    projectRegistryRoot,
    projectManifestPath: `${projectRegistryRoot}/project.json`,
  };
}

/** The jobs root that owns a job directory: <jobsRoot>/<shot_id>/<take_id-hash>. */
export function jobsRootFromJobDirectory(jobDirectory) {
  return resolve(jobDirectory, "..", "..");
}

/**
 * The same question as projectPathsFromJobsRoot, asked from the edit side.
 *
 * Lets the assembler find the frozen shot plan that governs a master without
 * adding a project pointer to the edit manifest, which would be a second answer
 * to "which project is this" and would drift from the first.
 * Returns null for an ad-hoc masters root, which no project governs.
 */
export function projectPathsFromMastersRoot(mastersRoot) {
  const normalized = posixPath(mastersRoot);
  const match = PROJECT_MASTERS_ROOT_PATTERN.exec(normalized);
  if (!match) return null;
  const [suffix, clientId, videoDirectory] = [match[0], match[1], match[2]];
  const workspaceRoot = normalized.slice(0, normalized.length - suffix.length);
  const projectRegistryRoot = `${workspaceRoot}/projects/${clientId}/${videoDirectory}`;
  return {
    workspaceRoot,
    clientId,
    videoDirectory,
    projectRegistryRoot,
    projectManifestPath: `${projectRegistryRoot}/project.json`,
    shotPlanPath: `${projectRegistryRoot}/brief/shotplan.json`,
  };
}

async function readDirectoryNames(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Read every job manifest of a project and split what it owes into two piles.
 *
 * `charged` is money the provider has already billed (usage.cost.usd appears
 * only after the task finished). `reserved` is money already committed but not
 * yet billed: submit stores usage.credits_reserved without a cost, so several
 * submissions made before the first wait would otherwise all see the same spend
 * and collectively walk through the cap.
 */
async function collectProjectJobCosts(jobsRoot) {
  const root = resolve(jobsRoot);
  const charged = [];
  const reserved = [];
  let chargedUsd = 0;
  let reservedUsd = 0;
  for (const shotId of await readDirectoryNames(root)) {
    for (const takeDirectory of await readDirectoryNames(join(root, shotId))) {
      const statePath = join(root, shotId, takeDirectory, "job.json");
      let state;
      try {
        state = JSON.parse(await readFile(statePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new Error(`Cannot read job manifest while summing project spend: ${statePath}`);
      }
      const cost = state?.usage?.cost?.usd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        chargedUsd += cost;
        charged.push({ shot_id: shotId, take: takeDirectory, usd: cost, kind: "charged" });
        continue;
      }
      if (!isReservedJob(state)) continue;
      const estimated = state?.cost_estimate;
      const estimatedUsd =
        estimated?.status === "estimated" && typeof estimated.usd === "number" ? estimated.usd : 0;
      reservedUsd += estimatedUsd;
      reserved.push({ shot_id: shotId, take: takeDirectory, usd: estimatedUsd, kind: "reserved" });
    }
  }
  // Provider costs carry three decimals; keep the sums free of float drift.
  return {
    charged: { usd: round(chargedUsd), jobs: charged },
    reserved: { usd: round(reservedUsd), jobs: reserved },
  };
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * A job holds money the moment submission starts and keeps holding it until the
 * provider either bills it or refuses it outright.
 */
function isReservedJob(state) {
  if (state?.paid_execution_started !== true) return false;
  return !NON_RESERVING_PHASES.has(state?.phase);
}

/**
 * What a project has actually been charged. Kept as the narrow "already billed"
 * figure that reporting and the cap message quote.
 */
export async function sumProjectSpendUsd(jobsRoot) {
  const { charged } = await collectProjectJobCosts(jobsRoot);
  return { usd: charged.usd, jobs: charged.jobs.map(({ kind, ...job }) => job) };
}

/**
 * Read-only view of a project's budget: no approval decision, no throwing on a
 * cap that is already blown. The gate below is built on top of it so the two can
 * never disagree about what has been spent.
 */
export async function readProjectBudget({ jobsRoot, production = null }) {
  const paths = projectPathsFromJobsRoot(jobsRoot);
  if (!paths) return { status: "not_project_bound", jobs_root: resolve(jobsRoot) };

  const manifest = await readProjectManifest(paths, production);
  if (production) {
    assertProjectIdentity(manifest, {
      clientId: production.client_id,
      projectId: production.project_id,
      videoNumber: production.video_number,
    });
  }

  const { charged, reserved } = await collectProjectJobCosts(jobsRoot);
  const limit = manifest.approval.max_total_cost;
  const committed = round(charged.usd + reserved.usd);
  return {
    status: "resolved",
    project_id: manifest.project_id,
    project_manifest_path: paths.projectManifestPath,
    jobs_root: resolve(jobsRoot),
    paid_generation: manifest.approval.paid_generation === true,
    max_total_cost: limit,
    spent_usd: charged.usd,
    reserved_usd: reserved.usd,
    committed_usd: committed,
    remaining_usd: limit === null ? null : round(limit - committed),
    jobs: [...charged.jobs, ...reserved.jobs].sort((a, b) =>
      `${a.shot_id}/${a.take}`.localeCompare(`${b.shot_id}/${b.take}`),
    ),
  };
}

async function readProjectManifest(paths, production) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths.projectManifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const subject = production ? `paid generation for ${production.project_id}` : "the budget";
      throw new Error(
        `Project manifest is missing, so ${subject} cannot be authorized: ${paths.projectManifestPath}`,
      );
    }
    throw error;
  }
  validateProjectManifest(manifest);
  return manifest;
}

function formatUsd(value) {
  return `$${value.toFixed(3)}`;
}

/**
 * Enforce the approval recorded in the project manifest before any paid call.
 *
 * A job that carries no metadata.production is not bound to a project and is
 * left alone; everything created through $produce-short-video carries it.
 * There is deliberately no override flag: raising max_total_cost in the
 * manifest is the only way through, so every increase leaves a trace.
 */
export async function assertBudgetAllows({ jobsRoot, request, estimate = null }) {
  const production = request?.metadata?.production;
  if (!production) {
    return { status: "not_project_bound" };
  }

  const normalized = productionMetadata(production).production;
  const paths = projectPathsFromJobsRoot(jobsRoot);
  if (!paths) {
    throw new Error(
      `Job declares metadata.production (${normalized.project_id}) but does not live under a project-specific artifacts/<client>/VNNN/jobs root: ${resolve(jobsRoot)}`,
    );
  }
  if (
    paths.clientId !== normalized.client_id ||
    paths.videoDirectory !== formatVideoDirectory(normalized.video_number)
  ) {
    throw new Error(
      `Job directory belongs to ${paths.clientId}/${paths.videoDirectory} but metadata.production declares ${normalized.project_id}`,
    );
  }

  const budget = await readProjectBudget({ jobsRoot, production: normalized });

  if (!budget.paid_generation) {
    throw new Error(
      `Paid generation is not approved for ${budget.project_id}: set approval.paid_generation to true in ${budget.project_manifest_path}`,
    );
  }

  const limit = budget.max_total_cost;
  const estimateStatus = estimate?.status ?? "unknown_rate";
  const estimatedUsd = typeof estimate?.usd === "number" ? estimate.usd : 0;

  const decision = {
    status: "approved",
    project_id: budget.project_id,
    project_manifest_path: budget.project_manifest_path,
    max_total_cost: limit,
    spent_usd: budget.spent_usd,
    ...(budget.reserved_usd > 0 ? { reserved_usd: budget.reserved_usd } : {}),
    estimate_status: estimateStatus,
    ...(estimateStatus === "estimated" ? { estimated_usd: estimatedUsd } : {}),
    ...(limit === null ? {} : { remaining_usd: round(limit - budget.committed_usd) }),
  };

  if (limit === null) {
    decision.note = "approval.max_total_cost is null: spend is approved but not capped";
    return decision;
  }

  const projected = round(budget.committed_usd + estimatedUsd);
  if (projected > limit) {
    // Reserved money is money already promised to the provider, so it belongs in
    // the message; when there is none, the wording stays exactly as before.
    const spentPart =
      budget.reserved_usd > 0
        ? `spent ${formatUsd(budget.spent_usd)} + reserved ${formatUsd(budget.reserved_usd)}`
        : `spent ${formatUsd(budget.spent_usd)}`;
    const detail =
      estimateStatus === "estimated"
        ? `${spentPart} + estimated ${formatUsd(estimatedUsd)} = ${formatUsd(projected)}`
        : `${spentPart} (cost of this job is unknown)`;
    throw new Error(
      `Budget exceeded for ${budget.project_id}: ${detail} over the approved cap of ${formatUsd(limit)}. Raise approval.max_total_cost in ${budget.project_manifest_path} to authorize more spend.`,
    );
  }

  if (estimateStatus !== "estimated") {
    decision.warning = `No measured price for this route, so the cap was checked against recorded spend only (${formatUsd(budget.committed_usd)} of ${formatUsd(limit)}).`;
  }
  return decision;
}

/**
 * What a project has spent and what it can still afford, in seconds of footage.
 *
 * Read-only and never throws on an exhausted cap: this is the view you consult
 * before deciding, while assertBudgetAllows is the decision itself.
 */
export async function describeProjectBudget({
  jobsRoot,
  model = "seedance-2.5",
  resolution = "720p",
} = {}) {
  const budget = await readProjectBudget({ jobsRoot });
  if (budget.status !== "resolved") return budget;

  // The rate comes from the same estimator the gate uses, so there is no second
  // copy of the price table to drift.
  const perSecond = estimateJobCost({ model, resolution, duration_seconds: 1, options: {} });
  const rate =
    perSecond.status === "estimated"
      ? {
          status: "estimated",
          model,
          route: perSecond.route,
          credits_per_second: perSecond.credits_per_second,
          usd_per_second: perSecond.usd,
          source: perSecond.source,
        }
      : { status: "unknown_rate", model, reason: perSecond.reason };

  let headroom = null;
  if (rate.status === "estimated" && budget.remaining_usd !== null && rate.usd_per_second > 0) {
    const seconds = Math.max(0, Math.floor(budget.remaining_usd / rate.usd_per_second));
    headroom = {
      usd: budget.remaining_usd,
      seconds,
      clips_4s: Math.floor(seconds / 4),
      clips_5s: Math.floor(seconds / 5),
    };
  }

  return { ...budget, rate, headroom };
}
