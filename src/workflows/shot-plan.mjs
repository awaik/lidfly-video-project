import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { hashFile } from "../core/hashing.mjs";
import { exists, readJson, writeJsonAtomic } from "../core/workspace-files.mjs";
import { continuityHash, createContinuity, normalizeContinuity } from "../domain/continuity.mjs";
import { productionMetadata } from "../domain/production-context.mjs";
import { shotPlanFindings } from "../domain/shot-plan-checks.mjs";
import { composeShotPrompt } from "../domain/shot-prompt.mjs";
import {
  aspectRatioForShot,
  createShotPlan,
  normalizeShotPlan,
  normalizeShotPlanReview,
  shotPlanHash,
} from "../domain/shot-plan.mjs";
import { resolveProjectRegistry } from "./asset-registry.mjs";

const PLAN_FILE = join("brief", "shotplan.json");
const CONTINUITY_FILE = join("brief", "continuity.json");

function planPaths(project) {
  return {
    planPath: join(project.registryRoot, PLAN_FILE),
    continuityPath: join(project.registryRoot, CONTINUITY_FILE),
    reviewsRoot: join(project.registryRoot, "reviews"),
    requestsRoot: join(project.registryRoot, "requests"),
  };
}

async function loadProject({ projectRoot, workspaceRoot }) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  return { project, paths: planPaths(project) };
}

async function loadPlanDocuments(project, paths) {
  if (!(await exists(paths.planPath))) {
    throw new Error(
      `Shot plan is missing for ${project.manifest.project_id}: run node src/cli.mjs script init --project ${relative(project.workspaceRoot, project.registryRoot)} --script <файл сценария>`,
    );
  }
  const plan = normalizeShotPlan(await readJson(paths.planPath, "Shot plan"));
  if (!(await exists(paths.continuityPath))) {
    throw new Error(
      `Continuity is missing for ${project.manifest.project_id}: ${paths.continuityPath}. Без него якоря света, локации и масштаба проверить нечем`,
    );
  }
  const continuity = normalizeContinuity(await readJson(paths.continuityPath, "Continuity"));
  return { plan, continuity };
}

async function loadAssetIds(project) {
  const manifestPath = join(project.registryRoot, "assets.json");
  if (!(await exists(manifestPath))) return null;
  const manifest = await readJson(manifestPath, "Assets manifest");
  return manifest.assets ?? [];
}

/** Shots recovered from request files, for a project that predates the plan. */
async function adoptExistingRequests(project) {
  const requestsRoot = join(project.registryRoot, "requests");
  if (!(await exists(requestsRoot))) return [];
  const files = (await readdir(requestsRoot)).filter((name) => name.endsWith(".json")).sort();
  const shots = new Map();
  for (const name of files) {
    let request;
    try {
      request = JSON.parse(await readFile(join(requestsRoot, name), "utf8"));
    } catch {
      continue;
    }
    if (!request?.shot_id || shots.has(request.shot_id)) continue;
    shots.set(request.shot_id, {
      shot_id: request.shot_id,
      // Beats, events and anchors are deliberately left empty: they cannot be
      // recovered from prose, and the first check must demand them.
      beat_ids: [],
      source: "generated",
      edit_purpose: request.metadata?.edit_purpose ?? "перенесено из существующего запроса",
      duration_seconds: request.duration_seconds ?? 4,
      timeline_seconds: request.duration_seconds ?? 4,
      shot_size: "medium",
      subject: [],
      events: [],
      continuity_keys: [],
      identity_refs: (request.references ?? []).map((reference) => reference.asset_id),
      route: { model: request.model ?? "seedance-2.5", mode: request.mode ?? "text_to_video" },
    });
  }
  return [...shots.values()];
}

export async function initShotPlan({
  projectRoot,
  workspaceRoot,
  scriptPath,
  title,
  durationSeconds,
  aspectRatio = "9:16",
  model,
  resolution = "720p",
  audioMode,
  adopt = false,
  now = new Date(),
}) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  if (await exists(paths.planPath)) {
    throw new Error(`Shot plan already exists: ${paths.planPath}. Правьте его, а не создавайте заново`);
  }

  const absoluteScript = resolve(project.workspaceRoot, scriptPath);
  if (!(await exists(absoluteScript))) throw new Error(`Source script does not exist: ${absoluteScript}`);

  const plan = createShotPlan({
    projectId: project.manifest.project_id,
    sourceScript: {
      path: relative(project.workspaceRoot, absoluteScript),
      sha256: await hashFile(absoluteScript),
      ...(title ? { title } : { title: basename(absoluteScript) }),
    },
    target: {
      duration_seconds_total: durationSeconds,
      aspect_ratio: aspectRatio,
      ...(model ? { model_default: model } : {}),
      resolution_default: resolution,
      ...(audioMode ? { audio_mode: audioMode } : {}),
    },
    now,
  });
  if (adopt) plan.shots = await adoptExistingRequests(project);

  const continuity = createContinuity({ projectId: project.manifest.project_id });
  await writeJsonAtomic(project.workspaceRoot, paths.planPath, normalizeShotPlan(plan), "shot plan");
  if (!(await exists(paths.continuityPath))) {
    await writeJsonAtomic(project.workspaceRoot, paths.continuityPath, continuity, "continuity");
  }

  return {
    project_id: project.manifest.project_id,
    plan_path: relative(project.workspaceRoot, paths.planPath),
    continuity_path: relative(project.workspaceRoot, paths.continuityPath),
    shots_seeded: plan.shots.length,
    next_step:
      "Опишите биты сценария и события шотов, заполните continuity.json, затем node src/cli.mjs script check",
  };
}

export async function checkShotPlan({ projectRoot, workspaceRoot }) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  const { plan, continuity } = await loadPlanDocuments(project, paths);
  const assets = await loadAssetIds(project);
  const result = shotPlanFindings({
    plan,
    continuity,
    assets,
    projectId: project.manifest.project_id,
  });
  return {
    project_id: project.manifest.project_id,
    plan_path: relative(project.workspaceRoot, paths.planPath),
    plan_status: plan.status,
    plan_hash: shotPlanHash(plan),
    summary: {
      beats: plan.beats.length,
      shots: plan.shots.length,
      generated_shots: plan.shots.filter((shot) => shot.source === "generated").length,
      timeline_seconds: Math.round(plan.shots.reduce((sum, shot) => sum + shot.timeline_seconds, 0) * 1e3) / 1e3,
    },
    ok: result.ok,
    blockers: result.blockers,
    warnings: result.warnings,
    findings: result.findings,
  };
}

export async function recordShotPlanReview({ projectRoot, workspaceRoot, recordPath, now = new Date() }) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  const { plan } = await loadPlanDocuments(project, paths);
  const absoluteRecord = resolve(project.workspaceRoot, recordPath);
  const review = normalizeShotPlanReview(await readJson(absoluteRecord, "Shot plan review"));

  const currentHash = shotPlanHash(plan);
  if (review.plan_hash !== currentHash) {
    throw new Error(
      `Review was written for plan ${review.plan_hash.slice(0, 12)} but the plan is now ${currentHash.slice(0, 12)}: перезапросите ревью после правок`,
    );
  }
  if (review.project_id !== plan.project_id) {
    throw new Error(`Review belongs to ${review.project_id}, not ${plan.project_id}`);
  }

  const storedName = `shotplan-${currentHash.slice(0, 12)}-R${review.reviewer_pass}.json`;
  const storedPath = join(paths.reviewsRoot, storedName);
  await writeJsonAtomic(project.workspaceRoot, storedPath, review, "shot plan review");

  const openBlockers = review.findings.filter((item) => item.level === "blocker").length;
  const next = {
    ...plan,
    status: review.verdict === "approve" && openBlockers === 0 ? "reviewed" : "draft",
    review: {
      record: relative(project.workspaceRoot, storedPath),
      reviewer_pass: review.reviewer_pass,
      plan_hash: currentHash,
      verdict: review.verdict,
    },
  };
  await writeJsonAtomic(project.workspaceRoot, paths.planPath, normalizeShotPlan(next), "shot plan");

  return {
    record_path: relative(project.workspaceRoot, storedPath),
    plan_hash: currentHash,
    reviewer_pass: review.reviewer_pass,
    blockers_open: openBlockers,
    failed_beats: review.beat_verdicts.filter((item) => item.verdict === "fail").map((item) => item.beat_id),
    verdict: review.verdict,
    plan_status: next.status,
    reviewed_at: now.toISOString(),
  };
}

export async function freezeShotPlan({ projectRoot, workspaceRoot, now = new Date() }) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  const { plan, continuity } = await loadPlanDocuments(project, paths);
  const currentHash = shotPlanHash(plan);

  if (plan.status === "frozen" && plan.plan_hash === currentHash) {
    return {
      project_id: plan.project_id,
      plan_hash: currentHash,
      continuity_hash: plan.continuity_hash,
      frozen_at: plan.frozen_at,
      check_snapshot: plan.check_snapshot,
      review: plan.review,
      reused: true,
    };
  }

  const assets = await loadAssetIds(project);
  const result = shotPlanFindings({ plan, continuity, assets, projectId: project.manifest.project_id });
  if (!result.ok) {
    throw new Error(
      `Shot plan still has ${result.blockers} blocker(s); freeze is only possible on a clean check: node src/cli.mjs script check --project ${relative(project.workspaceRoot, project.registryRoot)}`,
    );
  }
  if (!plan.review) {
    throw new Error(
      "Shot plan has no independent review recorded: заказать ревью и внести его через node src/cli.mjs script review --record <файл>",
    );
  }
  if (plan.review.plan_hash !== currentHash) {
    throw new Error(
      `Recorded review covers plan ${plan.review.plan_hash.slice(0, 12)} but the plan is now ${currentHash.slice(0, 12)}: нужно свежее ревью`,
    );
  }
  if (plan.review.verdict !== "approve") {
    throw new Error(`Recorded review verdict is "${plan.review.verdict}": заморозка возможна только после approve`);
  }

  const frozen = {
    ...plan,
    status: "frozen",
    plan_hash: currentHash,
    continuity_hash: continuityHash(continuity),
    frozen_at: now.toISOString(),
    check_snapshot: {
      ok: true,
      blockers: 0,
      warnings: result.warnings,
      checked_at: now.toISOString(),
    },
  };
  await writeJsonAtomic(project.workspaceRoot, paths.planPath, normalizeShotPlan(frozen), "shot plan");

  return {
    project_id: frozen.project_id,
    plan_hash: frozen.plan_hash,
    continuity_hash: frozen.continuity_hash,
    frozen_at: frozen.frozen_at,
    check_snapshot: frozen.check_snapshot,
    review: frozen.review,
    reused: false,
    next_step: `node src/cli.mjs script compose --project ${relative(project.workspaceRoot, project.registryRoot)}`,
  };
}

export async function composeShotRequests({
  projectRoot,
  workspaceRoot,
  shotId = null,
  takeId = "T001",
  dryRun = false,
}) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  const { plan, continuity } = await loadPlanDocuments(project, paths);
  if (plan.status !== "frozen") {
    throw new Error(`Shot plan is "${plan.status}": compose works on a frozen plan only`);
  }
  const currentHash = shotPlanHash(plan);
  if (plan.plan_hash !== currentHash) {
    throw new Error(
      `Frozen plan was edited after freezing (${plan.plan_hash?.slice(0, 12)} → ${currentHash.slice(0, 12)}): перезапустите check, ревью и freeze`,
    );
  }

  const assets = await loadAssetIds(project);
  const assetById = new Map((assets ?? []).map((asset) => [asset.asset_id, asset]));
  const shots = plan.shots.filter(
    (shot) => shot.source === "generated" && (!shotId || shot.shot_id === shotId),
  );
  if (shotId && shots.length === 0) throw new Error(`Shot ${shotId} is not a generated shot in this plan`);

  const production = productionMetadata({
    client_id: project.manifest.client_id,
    project_id: project.manifest.project_id,
    video_number: project.manifest.video_number,
  }).production;

  const requests = [];
  for (const shot of shots) {
    if (shot.route.model === "gemini-browser" && !/^B[1-9]\d*$/.test(takeId)) {
      throw new Error("Browser shots require --take-id B1, B2, ...");
    }
    const { prompt, blocks } = composeShotPrompt({ plan, continuity, shot });
    const references = shot.identity_refs.map((assetId) => {
      const asset = assetById.get(assetId);
      if (!asset) throw new Error(`Reference ${assetId} of ${shot.shot_id} is not in the project registry`);
      return {
        asset_id: assetId,
        role: "identity",
        path: join(project.registryRoot, asset.path),
        rights_status: asset.rights_status,
        ...(shot.route.model === "gemini-browser" ? { sha256: asset.sha256 } : {}),
      };
    });
    const request = {
      schema_version: shot.route.model === "gemini-browser" ? "browser-request/1" : 1,
      shot_id: shot.shot_id,
      take_id: takeId,
      provider: shot.route.model === "gemini-browser" ? "gemini-browser" : "evolink",
      model: shot.route.model,
      mode: shot.route.mode,
      prompt,
      duration_seconds: shot.duration_seconds,
      aspect_ratio: aspectRatioForShot(plan.target, shot.route),
      resolution: plan.target.resolution_default,
      generate_audio: shot.route.model === "gemini-browser" ? false : (plan.target.generate_audio ?? true),
      references,
      options: {},
      metadata: {
        production,
        script: { plan_hash: currentHash },
        beats: shot.beat_ids,
        edit_purpose: shot.edit_purpose,
        continuity_keys: shot.continuity_keys,
      },
    };

    const target = join(paths.requestsRoot, `${shot.shot_id}-${takeId}.json`);
    const relativeTarget = relative(project.workspaceRoot, target);
    if (dryRun) {
      requests.push({ shot_id: shot.shot_id, take_id: takeId, path: relativeTarget, blocks, written: false });
      continue;
    }

    const body = `${JSON.stringify(request, null, 2)}\n`;
    if (await exists(target)) {
      const current = await readFile(target, "utf8");
      if (current === body) {
        requests.push({ shot_id: shot.shot_id, take_id: takeId, path: relativeTarget, reused: true });
        continue;
      }
      throw new Error(
        `${relativeTarget} already exists with different content; compose the next take instead: --take-id T${String(
          Number(takeId.replace(/\D/g, "")) + 1,
        ).padStart(3, "0")}`,
      );
    }
    await writeFile(target, body, { encoding: "utf8", flag: "wx" });
    requests.push({ shot_id: shot.shot_id, take_id: takeId, path: relativeTarget, reused: false });
  }

  return {
    project_id: plan.project_id,
    plan_hash: currentHash,
    dry_run: dryRun,
    requests,
    next_step: dryRun
      ? "Проверьте блоки промпта и запустите compose без --dry-run"
      : `node src/cli.mjs plan --request <файл> --jobs-root ${project.manifest.storage.jobs_root}`,
  };
}

export async function shotPlanStatus({ projectRoot, workspaceRoot }) {
  const { project, paths } = await loadProject({ projectRoot, workspaceRoot });
  if (!(await exists(paths.planPath))) {
    return {
      project_id: project.manifest.project_id,
      plan_status: "absent",
      gate_ready: false,
      next_step: "node src/cli.mjs script init --project <path> --script <файл сценария>",
    };
  }
  const { plan, continuity } = await loadPlanDocuments(project, paths);
  const currentHash = shotPlanHash(plan);
  const tampered = plan.status === "frozen" && plan.plan_hash !== currentHash;
  const continuityTampered =
    plan.status === "frozen" && plan.continuity_hash !== continuityHash(continuity);
  const composed = (await exists(paths.requestsRoot))
    ? (await readdir(paths.requestsRoot)).filter((name) => name.endsWith(".json")).length
    : 0;

  return {
    project_id: plan.project_id,
    plan_status: plan.status,
    plan_hash: currentHash,
    recorded_plan_hash: plan.plan_hash,
    plan_tampered: tampered,
    continuity_tampered: continuityTampered,
    frozen_at: plan.frozen_at,
    review: plan.review,
    check_snapshot: plan.check_snapshot,
    beats: plan.beats.length,
    shots: plan.shots.length,
    composed_requests: composed,
    gate_ready: plan.status === "frozen" && !tampered && !continuityTampered,
  };
}
