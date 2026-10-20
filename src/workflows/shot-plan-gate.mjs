import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../core/workspace-files.mjs";
import { continuityHash, normalizeContinuity } from "../domain/continuity.mjs";
import { formatVideoDirectory, productionMetadata } from "../domain/production-context.mjs";
import {
  aspectRatioForShot,
  normalizeScriptBinding,
  normalizeShotPlan,
  shotPlanHash,
} from "../domain/shot-plan.mjs";
import { projectPathsFromJobsRoot } from "./budget.mjs";

async function readJsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} could not be read: ${path}`);
  }
}

function waiverFor(manifest, shotId) {
  const waiver = manifest?.approval?.script_plan_waiver;
  if (!waiver) return null;
  return waiver.shot_ids.includes(shotId) ? waiver : null;
}

/**
 * Refuse paid generation for a shot that is not part of a frozen, reviewed plan.
 *
 * Mirrors the budget gate on purpose: same notion of "which project owns this
 * jobs root", same absence of an override flag. A plan that was edited after
 * freezing fails too — otherwise the gate could be satisfied by writing a shot
 * into the file after the reviewer looked at it.
 */
export async function assertShotPlanAllows({ jobsRoot, request }) {
  const production = request?.metadata?.production;
  if (!production) return { status: "not_project_bound" };

  const normalized = productionMetadata(production).production;
  const paths = projectPathsFromJobsRoot(jobsRoot);
  if (!paths) {
    throw new Error(
      `Job declares metadata.production (${normalized.project_id}) but does not live under a project-specific artifacts/<client>/VNNN/jobs root`,
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

  const manifest = await readJsonFile(paths.projectManifestPath, "Project manifest");
  if (!manifest) {
    // A project with no manifest does not exist yet. That is a more precise
    // complaint than "no plan", and the budget gate makes it a line later.
    return { status: "project_manifest_missing", project_id: normalized.project_id };
  }
  const waiver = waiverFor(manifest, request.shot_id);
  if (waiver) {
    return {
      status: "waived",
      project_id: normalized.project_id,
      shot_id: request.shot_id,
      reason: waiver.reason,
      waived_by: waiver.waived_by,
      waived_at: waiver.waived_at,
    };
  }

  const planPath = join(paths.projectRegistryRoot, "brief", "shotplan.json");
  const continuityPath = join(paths.projectRegistryRoot, "brief", "continuity.json");
  const fix = `node src/cli.mjs script check --project projects/${paths.clientId}/${paths.videoDirectory}`;

  if (!(await exists(planPath))) {
    throw new Error(
      `No frozen shot plan for ${normalized.project_id}, so paid generation cannot start: create one with node src/cli.mjs script init --project projects/${paths.clientId}/${paths.videoDirectory} --script <файл сценария>, then ${fix} and script freeze.`,
    );
  }
  const plan = normalizeShotPlan(await readJsonFile(planPath, "Shot plan"));
  if (plan.status !== "frozen") {
    throw new Error(
      `Shot plan for ${normalized.project_id} is "${plan.status}", not frozen: ${fix}, record an independent review, then script freeze.`,
    );
  }

  const currentHash = shotPlanHash(plan);
  if (plan.plan_hash !== currentHash) {
    throw new Error(
      `Shot plan for ${normalized.project_id} was edited after freezing (${plan.plan_hash?.slice(0, 12)} → ${currentHash.slice(0, 12)}): the reviewed plan is not what is on disk. Re-run ${fix}, review it again, and freeze.`,
    );
  }

  const continuityDocument = await readJsonFile(continuityPath, "Continuity");
  if (!continuityDocument) {
    throw new Error(`Continuity is missing for ${normalized.project_id}: ${continuityPath}`);
  }
  const currentContinuityHash = continuityHash(normalizeContinuity(continuityDocument));
  if (plan.continuity_hash !== currentContinuityHash) {
    throw new Error(
      `Continuity for ${normalized.project_id} changed after the plan was frozen: anchors the reviewer approved are no longer the ones that would be rendered. Re-freeze the plan.`,
    );
  }

  const binding = request?.metadata?.script;
  if (!binding) {
    throw new Error(
      `Request for ${request.shot_id} carries no metadata.script.plan_hash: build it with node src/cli.mjs script compose --project projects/${paths.clientId}/${paths.videoDirectory}`,
    );
  }
  const { plan_hash: boundHash } = normalizeScriptBinding(binding);
  if (boundHash !== currentHash) {
    throw new Error(
      `Request for ${request.shot_id} was composed from plan ${boundHash.slice(0, 12)} but the frozen plan is ${currentHash.slice(0, 12)}: re-run script compose.`,
    );
  }

  const shot = plan.shots.find((entry) => entry.shot_id === request.shot_id);
  if (!shot) {
    throw new Error(`Shot ${request.shot_id} is not part of the frozen plan for ${normalized.project_id}`);
  }
  if (shot.duration_seconds !== request.duration_seconds) {
    throw new Error(
      `Shot ${request.shot_id} is planned as ${shot.duration_seconds} s but the request asks for ${request.duration_seconds} s: the plan is what was reviewed.`,
    );
  }
  if (shot.route.model !== request.model || shot.route.mode !== request.mode) {
    throw new Error(
      `Shot ${request.shot_id} is planned as ${shot.route.model}/${shot.route.mode} but the request uses ${request.model}/${request.mode}: a model change is a plan decision.`,
    );
  }
  // Only a plan that declares it binds the soundtrack: older plans left it to
  // the request, and a voiceover project must not pick up native model audio.
  if (plan.target.generate_audio !== undefined && plan.target.generate_audio !== request.generate_audio) {
    throw new Error(
      `Shot ${request.shot_id} is planned with generate_audio=${plan.target.generate_audio} but the request asks for ${request.generate_audio}: the soundtrack route is a plan decision.`,
    );
  }
  // The delivery shape is a plan decision like the others. A hand-written
  // request that quietly flips orientation produces a take nothing in the edit
  // can use, and the cost is already spent by the time anyone sees the frame.
  const plannedAspectRatio = aspectRatioForShot(plan.target, shot.route);
  if (plannedAspectRatio !== request.aspect_ratio) {
    throw new Error(
      `Shot ${request.shot_id} is planned as ${plannedAspectRatio} but the request asks for ${request.aspect_ratio}: an aspect ratio change is a plan decision.`,
    );
  }

  return {
    status: "approved",
    project_id: plan.project_id,
    plan_path: planPath,
    plan_hash: currentHash,
    shot_id: shot.shot_id,
    beat_ids: shot.beat_ids,
    frozen_at: plan.frozen_at,
  };
}
