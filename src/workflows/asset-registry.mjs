import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { httpUrl, optionalString } from "../core/validation.mjs";
import {
  assertSafeWorkspacePath,
  exists,
  mkdirSafe,
  pathIsInside,
  readJson,
  resolveWorkspaceRoot,
  writeJsonAtomic,
} from "../core/workspace-files.mjs";
import {
  ASSET_STATUSES,
  assetQualityFindings,
  assetStatus,
  createAssetsManifest,
  detectImage,
  formatAspectRatio,
  normalizeAssetId,
  normalizeRightsStatus,
  normalizeRole,
  sha256,
  validateAssetRecord,
  validateAssetsManifest,
} from "../domain/reference-asset.mjs";
import { validateProjectManifest } from "../domain/production-context.mjs";
import {
  DEFAULT_VIDEO_MODEL,
  isAdaptiveOnlyMode,
  normalizeVideoRequest,
} from "../domain/video-request.mjs";
import {
  buildEvolinkPayload,
  describeModeCapacity,
  referenceFileLimits,
} from "../providers/evolink/model-catalog.mjs";

const MODULE_WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGINALS_DIRECTORY = "assets/originals";
const PLACEHOLDER_VIDEO_URL = "https://example.invalid/preflight-reference-video.mp4";
const MANIFEST_LOCK_ATTEMPTS = 200;
const MANIFEST_LOCK_DELAY_MS = 10;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function acquireManifestLock(workspaceRoot, lockPath) {
  await assertSafeWorkspacePath(workspaceRoot, lockPath, "assets manifest lock");
  for (let attempt = 1; attempt <= MANIFEST_LOCK_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      return async () => {
        await handle.close();
        await unlink(lockPath);
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
      if (attempt < MANIFEST_LOCK_ATTEMPTS) {
        await delay(MANIFEST_LOCK_DELAY_MS + (attempt % 7));
      }
    }
  }
  throw new Error(
    `Could not lock assets.json after ${MANIFEST_LOCK_ATTEMPTS} attempts; another assets add may still be running`,
  );
}

/** Resolve the managed registry root that owns `project.json`, never a caller-invented path. */
export async function resolveProjectRegistry({ projectRoot, workspaceRoot } = {}) {
  const workspace = await resolveWorkspaceRoot(workspaceRoot, MODULE_WORKSPACE_ROOT);
  if (!projectRoot) throw new TypeError("project root is required");
  const registryRoot = resolve(workspace, projectRoot);
  if (!pathIsInside(workspace, registryRoot)) {
    throw new Error(`project root escapes the workspace: ${registryRoot}`);
  }
  await assertSafeWorkspacePath(workspace, registryRoot, "project root");
  const info = await stat(registryRoot).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Project root does not exist: ${registryRoot}`);
    throw error;
  });
  if (!info.isDirectory()) throw new Error(`Project root is not a directory: ${registryRoot}`);

  const manifestPath = join(registryRoot, "project.json");
  await assertSafeWorkspacePath(workspace, manifestPath, "project manifest");
  const manifest = await readJson(manifestPath, "Project manifest");
  try {
    validateProjectManifest(manifest);
  } catch (error) {
    throw new Error(`Invalid project manifest at ${manifestPath}: ${error.message}`);
  }
  return { workspaceRoot: workspace, registryRoot, manifest, manifestPath };
}

async function loadAssetsManifest(workspaceRoot, registryRoot, projectId) {
  const manifestPath = join(registryRoot, "assets.json");
  await assertSafeWorkspacePath(workspaceRoot, manifestPath, "assets manifest");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    validateAssetsManifest(manifest);
    if (manifest.project_id !== projectId) {
      throw new Error(
        `assets manifest project_id ${manifest.project_id} does not match ${projectId}`,
      );
    }
    return { manifestPath, manifest, existed: true };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(`assets manifest contains invalid JSON at ${manifestPath}`);
      }
      throw error;
    }
    return { manifestPath, manifest: createAssetsManifest(projectId), existed: false };
  }
}

export async function listReferenceAssets(options = {}) {
  const project = await resolveProjectRegistry(options);
  const { manifest: assets } = await loadAssetsManifest(
    project.workspaceRoot,
    project.registryRoot,
    project.manifest.project_id,
  );
  return {
    project_id: project.manifest.project_id,
    project_root: relative(project.workspaceRoot, project.registryRoot).split(sep).join("/"),
    assets: assets.assets,
  };
}

/**
 * Copy a reference the user supplied into the project, fingerprint it, and record it.
 * The user's original file is never moved, rewritten, or deleted, and an existing asset_id is
 * never overwritten with different content.
 */
export async function addReferenceAsset({
  projectRoot,
  workspaceRoot,
  filePath,
  assetId,
  role,
  rightsStatus,
  note,
  now = new Date(),
} = {}) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  const normalizedAssetId = normalizeAssetId(assetId);
  const normalizedRole = normalizeRole(role);
  const normalizedRights = normalizeRightsStatus(rightsStatus);
  const normalizedNote = optionalString(note, "note", { max: 500 });

  if (!filePath) throw new TypeError("file path is required");
  const sourcePath = resolve(filePath);
  const sourceInfo = await stat(sourcePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Reference file does not exist: ${sourcePath}`);
    throw error;
  });
  if (!sourceInfo.isFile()) throw new Error(`Reference is not a file: ${sourcePath}`);

  const contents = await readFile(sourcePath);
  const image = detectImage(contents);
  if (!image) {
    throw new Error(
      `Unsupported reference format: ${sourcePath}. Локальные референсы принимаются только как JPEG, PNG или WebP; HEIC, AVIF и видео нужно сначала сконвертировать.`,
    );
  }

  const digest = sha256(contents);
  const record = validateAssetRecord({
    asset_id: normalizedAssetId,
    role: normalizedRole,
    path: `${ORIGINALS_DIRECTORY}/${normalizedAssetId}${image.extension}`,
    format: image.format,
    mime_type: image.mime_type,
    width: image.width,
    height: image.height,
    aspect_ratio: formatAspectRatio(image.width, image.height),
    size_bytes: contents.length,
    sha256: digest,
    rights_status: normalizedRights,
    ...(normalizedNote === undefined ? {} : { note: normalizedNote }),
    added_at: now.toISOString(),
  });

  const manifestPath = join(project.registryRoot, "assets.json");
  const releaseLock = await acquireManifestLock(
    project.workspaceRoot,
    `${manifestPath}.lock`,
  );
  try {
    const { manifest: assets } = await loadAssetsManifest(
      project.workspaceRoot,
      project.registryRoot,
      project.manifest.project_id,
    );
    const existing = assets.assets.find((item) => item.asset_id === normalizedAssetId);
    if (existing) {
      if (existing.sha256 !== digest) {
        throw new Error(
          `asset_id ${normalizedAssetId} already holds different content (${existing.path}); choose a new asset_id instead of overwriting a reference`,
        );
      }
      if (existing.role !== normalizedRole) {
        throw new Error(
          `asset_id ${normalizedAssetId} is already registered with role ${existing.role}; register the same file under a second asset_id if it must serve another role`,
        );
      }
      const storedPath = resolve(project.registryRoot, existing.path);
      const originalsRoot = join(project.registryRoot, ORIGINALS_DIRECTORY);
      if (!pathIsInside(originalsRoot, storedPath)) {
        throw new Error(`Registered asset path escapes ${ORIGINALS_DIRECTORY}: ${existing.path}`);
      }
      await assertSafeWorkspacePath(project.workspaceRoot, storedPath, "registered asset original");
      const storedInfo = await stat(storedPath).catch((error) => {
        if (error?.code === "ENOENT") {
          throw new Error(`Registered original is missing for asset_id ${normalizedAssetId}: ${existing.path}`);
        }
        throw error;
      });
      if (!storedInfo.isFile()) {
        throw new Error(`Registered original is not a file for asset_id ${normalizedAssetId}: ${existing.path}`);
      }
      if (sha256(await readFile(storedPath)) !== existing.sha256) {
        throw new Error(`Registered original no longer matches assets.json for asset_id ${normalizedAssetId}`);
      }
      return { reused: true, asset: existing, findings: [], manifest_path: manifestPath };
    }

    const duplicate = assets.assets.find((item) => item.sha256 === digest);
    const targetPath = join(project.registryRoot, record.path);
    const originalsRoot = join(project.registryRoot, ORIGINALS_DIRECTORY);
    if (!pathIsInside(originalsRoot, targetPath)) {
      throw new Error(`Resolved asset path escapes ${ORIGINALS_DIRECTORY}: ${targetPath}`);
    }
    await mkdirSafe(project.workspaceRoot, dirname(targetPath), "asset originals directory");
    await assertSafeWorkspacePath(project.workspaceRoot, targetPath, "asset original");
    try {
      await writeFile(targetPath, contents, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw new Error(
        `A file already exists at ${record.path} but is not registered in assets.json; inspect it before reusing this asset_id`,
      );
    }

    assets.assets.push(record);
    assets.assets.sort((left, right) => left.asset_id.localeCompare(right.asset_id));
    validateAssetsManifest(assets);
    await writeJsonAtomic(project.workspaceRoot, manifestPath, assets);

    return {
      reused: false,
      asset: record,
      findings: assetQualityFindings(record, { duplicateOf: duplicate?.asset_id ?? null }),
      manifest_path: manifestPath,
    };
  } finally {
    await releaseLock();
  }
}

function fileCompatibilityFindings(asset, model) {
  const limits = referenceFileLimits(model);
  const findings = [];
  if (!limits.formats.includes(asset.format)) {
    findings.push({
      level: "blocker",
      code: "unsupported_format",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: ${model} не принимает ${asset.format}; допустимы ${limits.formats.join(", ")}`,
    });
  }
  if (asset.size_bytes > limits.max_bytes) {
    findings.push({
      level: "blocker",
      code: "file_too_large",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: ${(asset.size_bytes / 1024 / 1024).toFixed(1)}MB при лимите ${limits.max_bytes / 1024 / 1024}MB для ${model}`,
    });
  }
  return findings;
}

function buildPreflightRequest(
  assets,
  { model, mode, aspectRatio, resolution, capacity, videoReference },
) {
  const references = assets.map((asset) => ({
    asset_id: asset.asset_id,
    role: asset.role,
    url: `https://example.invalid/${asset.asset_id}`,
    rights_status: asset.rights_status,
  }));
  for (const role of capacity.required_roles ?? []) {
    if (["reference_video", "source_video"].includes(role)) {
      references.push(
        videoReference ?? {
          asset_id: `preflight-${role}`,
          role,
          url: PLACEHOLDER_VIDEO_URL,
          rights_status: "approved",
        },
      );
    }
  }
  return {
    schema_version: 1,
    shot_id: "PREFLIGHT",
    take_id: "T000",
    model,
    mode,
    prompt: "preflight capacity check",
    aspect_ratio: aspectRatio,
    resolution,
    references,
    metadata: { preflight: true },
  };
}

/**
 * What shape this project is actually delivering.
 *
 * The shot plan already carries the answer and is the reviewed, frozen document
 * that says so, so reading it beats assuming a default: a landscape project
 * used to get told its landscape stills were the wrong shape.
 */
async function deliveryAspectRatio(project, explicit) {
  if (explicit !== undefined) return { aspect_ratio: explicit, source: "explicit" };
  const planPath = join(project.registryRoot, "brief", "shotplan.json");
  if (await exists(planPath)) {
    const plan = await readJson(planPath, "Shot plan");
    if (plan?.target?.aspect_ratio) {
      return { aspect_ratio: plan.target.aspect_ratio, source: "shot_plan" };
    }
  }
  return { aspect_ratio: "9:16", source: "default" };
}

/**
 * Answer "does this pile of photos fit the mode I picked?" before any paid call, using the same
 * catalog that builds the real payload so the verdict cannot drift from the submitted request.
 */
export async function checkReferenceAssets({
  projectRoot,
  workspaceRoot,
  model = DEFAULT_VIDEO_MODEL,
  mode,
  assetIds = null,
  aspectRatio,
  resolution = "720p",
  videoUrl,
  videoRightsStatus,
} = {}) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  const { manifest: registry } = await loadAssetsManifest(
    project.workspaceRoot,
    project.registryRoot,
    project.manifest.project_id,
  );
  const capacity = describeModeCapacity(model, mode);
  const target = await deliveryAspectRatio(project, aspectRatio);
  const effectiveAspectRatio =
    aspectRatio ?? (isAdaptiveOnlyMode(model, mode) ? "adaptive" : target.aspect_ratio);
  const requiredVideoRoles = (capacity.required_roles ?? []).filter((role) =>
    ["reference_video", "source_video"].includes(role),
  );
  if (videoUrl !== undefined && requiredVideoRoles.length !== 1) {
    throw new TypeError(
      `--video-url is supported only for a mode with one required video role; ${model}/${mode} has ${requiredVideoRoles.length}`,
    );
  }
  if ((videoUrl === undefined) !== (videoRightsStatus === undefined)) {
    throw new TypeError("--video-url and --video-rights must be provided together");
  }
  const videoReference =
    videoUrl === undefined
      ? null
      : {
          asset_id: `preflight-${requiredVideoRoles[0]}`,
          role: requiredVideoRoles[0],
          url: httpUrl(videoUrl, "video_url", { httpsOnly: true }),
          rights_status: normalizeRightsStatus(videoRightsStatus),
        };

  // Retired assets do not take up mode capacity: they are history, not inputs.
  let selected = registry.assets.filter((asset) => assetStatus(asset) === "active");
  const retiredRequested = [];
  if (assetIds) {
    const wanted = assetIds.map((value) => normalizeAssetId(value));
    const known = new Map(registry.assets.map((asset) => [asset.asset_id, asset]));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) {
      throw new Error(`Unknown asset_id(s) in this project: ${missing.join(", ")}`);
    }
    selected = wanted.map((id) => known.get(id));
    retiredRequested.push(...selected.filter((asset) => assetStatus(asset) !== "active"));
  }

  const findings = [];
  for (const asset of retiredRequested) {
    findings.push({
      level: "blocker",
      code: "retired_asset_requested",
      asset_id: asset.asset_id,
      message: `${asset.asset_id} помечен как ${asset.status} (${asset.status_note}); верните его через assets retire --status active или подайте актуальный референс`,
    });
  }
  const seen = new Map();
  for (const asset of selected) {
    findings.push(...fileCompatibilityFindings(asset, model));
    findings.push(
      ...assetQualityFindings(asset, {
        aspectRatio: effectiveAspectRatio,
        targetAspectRatio: target.aspect_ratio,
        duplicateOf: seen.get(asset.sha256) ?? null,
      }),
    );
    if (!seen.has(asset.sha256)) seen.set(asset.sha256, asset.asset_id);
  }

  for (const role of capacity.required_roles ?? []) {
    if (["reference_video", "source_video"].includes(role) && !videoReference) {
      findings.push({
        level: "blocker",
        code: "video_reference_required",
        asset_id: null,
        message: `${model}/${mode} требует ${role}; локальная загрузка видео не поддерживается — передай публичный HTTPS URL через --video-url и затем в самом request`,
      });
    }
  }

  const images = selected.length;
  if (capacity.images === 0) {
    // A build probe would only restate this as a role error, so keep one unambiguous verdict.
    if (images > 0) {
      findings.push({
        level: "blocker",
        code: "references_unsupported",
        asset_id: null,
        message: `${model}/${mode} не принимает изображения; убери ${images} референс(ов) из request или выбери режим с референсами`,
      });
    }
  } else {
    if (images > capacity.images) {
      findings.push({
        level: "blocker",
        code: "too_many_images",
        asset_id: null,
        message: `${images} изображений при лимите ${capacity.images} для ${model}/${mode} — выбери подмножество или смени режим`,
      });
    }
    try {
      const preflight = normalizeVideoRequest(
        buildPreflightRequest(selected, {
          model,
          mode,
          aspectRatio: effectiveAspectRatio,
          resolution,
          capacity,
          videoReference,
        }),
      );
      buildEvolinkPayload(preflight);
    } catch (error) {
      findings.push({
        level: "blocker",
        code: "capacity_conflict",
        asset_id: null,
        message: `${model}/${mode}: ${String(error?.message ?? error)}`,
      });
    }
  }

  const blockers = findings.filter((finding) => finding.level === "blocker");
  return {
    project_id: project.manifest.project_id,
    model,
    mode,
    aspect_ratio: effectiveAspectRatio,
    // Which answer the target came from, so a wrong one is traceable to the
    // plan or to the flag rather than looking like a default nobody chose.
    aspect_ratio_source: target.source,
    resolution,
    capacity,
    selected_assets: selected.map((asset) => ({
      asset_id: asset.asset_id,
      role: asset.role,
      format: asset.format,
      dimensions: `${asset.width}x${asset.height}`,
      aspect_ratio: asset.aspect_ratio,
      rights_status: asset.rights_status,
    })),
    video_reference: videoReference,
    ok: blockers.length === 0,
    findings,
  };
}

/**
 * Mark an asset as superseded or unused without touching a byte of it.
 *
 * The registry is where "we stopped using this" belongs; the original file is
 * the user's copy and stays exactly where ingestion put it.
 */
export async function retireReferenceAsset({
  projectRoot,
  workspaceRoot,
  assetId,
  status,
  supersededBy,
  note,
  now = new Date(),
} = {}) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  const id = normalizeAssetId(assetId);
  if (!ASSET_STATUSES.includes(status)) {
    throw new RangeError(`--status must be one of: ${ASSET_STATUSES.join(", ")}`);
  }
  const reason = optionalString(note, "--note", { max: 500 });
  if (status !== "active" && !reason) throw new TypeError("--note is required when retiring an asset");
  if (status === "active" && !reason) throw new TypeError("--note is required when restoring an asset");

  const manifestPath = join(project.registryRoot, "assets.json");
  const release = await acquireManifestLock(project.workspaceRoot, `${manifestPath}.lock`);
  try {
    const manifest = await readJson(manifestPath, "Assets manifest");
    validateAssetsManifest(manifest);
    const record = manifest.assets.find((asset) => asset.asset_id === id);
    if (!record) throw new Error(`Asset ${id} is not in the project registry`);

    const previousStatus = assetStatus(record);
    const updated = { ...record };
    if (status === "active") {
      delete updated.status;
      delete updated.superseded_by;
      delete updated.status_note;
      updated.status_changed_at = now.toISOString();
      updated.note = record.note;
    } else {
      updated.status = status;
      updated.status_note = reason;
      updated.status_changed_at = now.toISOString();
      if (status === "superseded") {
        updated.superseded_by = normalizeAssetId(supersededBy ?? "");
      } else {
        delete updated.superseded_by;
      }
    }
    if (updated.note === undefined) delete updated.note;

    const next = {
      ...manifest,
      assets: manifest.assets
        .map((asset) => (asset.asset_id === id ? updated : asset))
        .sort((left, right) => left.asset_id.localeCompare(right.asset_id)),
    };
    validateAssetsManifest(next);
    await writeJsonAtomic(project.workspaceRoot, manifestPath, next, "assets manifest");
    return {
      asset: updated,
      previous_status: previousStatus,
      manifest_path: relative(project.workspaceRoot, manifestPath),
    };
  } finally {
    await release();
  }
}
