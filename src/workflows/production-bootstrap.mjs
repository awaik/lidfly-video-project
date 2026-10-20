import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDirectory,
  assertSafeWorkspacePath,
  exists,
  mkdirSafe,
  readJson,
  resolveWorkspaceRoot,
} from "../core/workspace-files.mjs";
import {
  MAX_VIDEO_NUMBER,
  assertClientIdentity,
  assertProjectIdentity,
  clientNameCaseWarning,
  createClientManifest,
  createProjectManifest,
  createVariantsManifest,
  formatProjectId,
  formatVideoDirectory,
  normalizeClientId,
  normalizeClientName,
  normalizeVideoNumber,
  normalizeWorkspaceRelativePath,
  productionContextFromManifest as contextFromManifest,
  productionMetadata,
  validateLegacyVariantsManifest,
} from "../domain/production-context.mjs";

export { productionMetadata };

const MODULE_WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_DIRECTORIES = ["brief", "assets", "requests", "reviews", "edits"];
const MODES = new Set(["ensure", "new", "resume"]);
const MAX_ALLOCATION_ATTEMPTS = 100;

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectLayout(clientId, videoNumber, legacyProjectRoot = null) {
  const videoDirectory = formatVideoDirectory(videoNumber);
  const registryRoot = `projects/${clientId}/${videoDirectory}`;
  const artifactRoot = `artifacts/${clientId}/${videoDirectory}`;
  return {
    videoDirectory,
    registryRoot,
    storage: {
      mode: legacyProjectRoot ? "legacy_alias" : "standard",
      project_root: legacyProjectRoot ?? registryRoot,
      jobs_root: `${artifactRoot}/jobs`,
      audio_root: `${artifactRoot}/audio`,
      masters_root: `${artifactRoot}/masters`,
    },
  };
}

function workspaceRelative(workspaceRoot, absolutePath) {
  return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

async function preservedStagingWarnings(workspaceRoot, clientId) {
  const candidates = [
    {
      root: join(workspaceRoot, "projects"),
      pattern: new RegExp(`^\\.${clientId}\\.bootstrap-`),
    },
    {
      root: join(workspaceRoot, "projects", clientId),
      pattern: /^\.V\d+\.bootstrap-/,
    },
  ];
  const warnings = [];
  for (const candidate of candidates) {
    if (!(await exists(candidate.root))) continue;
    for (const entry of await readdir(candidate.root, { withFileTypes: true })) {
      if (!candidate.pattern.test(entry.name)) continue;
      warnings.push(
        `Preserved staging entry requires review: ${workspaceRelative(workspaceRoot, join(candidate.root, entry.name))}`,
      );
    }
  }
  return warnings.sort();
}

async function loadClientManifest(clientManifestPath, expected) {
  const manifest = await readJson(clientManifestPath, "Client manifest");
  try {
    return assertClientIdentity(manifest, expected);
  } catch (error) {
    throw new Error(`Invalid client manifest at ${clientManifestPath}: ${error.message}`);
  }
}

async function ensureClient({ workspaceRoot, clientId, clientName, createdAt }) {
  const projectsRoot = join(workspaceRoot, "projects");
  const clientRoot = join(projectsRoot, clientId);
  const clientManifestPath = join(clientRoot, "client.json");
  await mkdirSafe(workspaceRoot, projectsRoot, "projects root");
  await assertSafeWorkspacePath(workspaceRoot, clientRoot, "client root");

  if (await exists(clientRoot)) {
    await assertDirectory(clientRoot, "client root");
    const manifest = await loadClientManifest(clientManifestPath, { clientId, clientName });
    await mkdirSafe(workspaceRoot, join(clientRoot, "brand"), "client brand directory");
    return { manifest, created: false, warning: clientNameCaseWarning(manifest, clientName) };
  }
  if (clientName === undefined) {
    throw new Error(`--client-name is required when creating client ${clientId}`);
  }

  const manifest = createClientManifest({ clientId, clientName, createdAt });
  const stagingRoot = join(projectsRoot, `.${clientId}.bootstrap-${process.pid}-${randomUUID()}`);
  let ownsStaging = false;
  try {
    await assertSafeWorkspacePath(workspaceRoot, stagingRoot, "client staging directory");
    await mkdir(stagingRoot);
    ownsStaging = true;
    await mkdir(join(stagingRoot, "brand"));
    await writeFile(join(stagingRoot, "client.json"), jsonText(manifest), {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await rename(stagingRoot, clientRoot);
      ownsStaging = false;
      return { manifest, created: true };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  } finally {
    if (ownsStaging) await rm(stagingRoot, { recursive: true, force: true });
  }

  const existing = await loadClientManifest(clientManifestPath, { clientId, clientName });
  await mkdirSafe(workspaceRoot, join(clientRoot, "brand"), "client brand directory");
  return { manifest: existing, created: false, warning: clientNameCaseWarning(existing, clientName) };
}

async function assertRecognizableLegacyProject(workspaceRoot, legacyRoot) {
  await assertSafeWorkspacePath(workspaceRoot, legacyRoot, "legacy project root");
  await assertDirectory(legacyRoot, "legacy project root");
  const variantsPath = join(legacyRoot, "variants.json");
  const legacyProjectPath = join(legacyRoot, "project.json");

  if (await exists(variantsPath)) {
    const variants = await readJson(variantsPath, "Legacy variants manifest");
    try {
      validateLegacyVariantsManifest(variants);
    } catch (error) {
      throw new Error(`Invalid legacy production manifest at ${variantsPath}: ${error.message}`);
    }
    return;
  }
  if (await exists(legacyProjectPath)) {
    const manifest = await readJson(legacyProjectPath, "Legacy project manifest");
    if (
      !manifest ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      manifest.schema_version !== 1 ||
      typeof manifest.project_id !== "string" ||
      manifest.project_id.trim().length === 0
    ) {
      throw new Error(`Unrecognized legacy production manifest: ${legacyProjectPath}`);
    }
    return;
  }
  throw new Error(
    `Legacy project root has no recognizable project.json or variants.json: ${legacyRoot}`,
  );
}

function assertExpectedStorage(manifest, layout) {
  for (const field of ["jobs_root", "audio_root", "masters_root"]) {
    if (manifest.storage[field] !== layout.storage[field]) {
      throw new Error(
        `Project storage conflict in ${field}: expected ${layout.storage[field]}, found ${manifest.storage[field]}`,
      );
    }
  }
  if (
    manifest.storage.mode === "standard" &&
    manifest.storage.project_root !== layout.registryRoot
  ) {
    throw new Error(
      `Project storage conflict in project_root: expected ${layout.registryRoot}, found ${manifest.storage.project_root}`,
    );
  }
}

async function validateExistingProject({ workspaceRoot, clientId, videoNumber, targetRoot }) {
  await assertSafeWorkspacePath(workspaceRoot, targetRoot, "project registry root");
  await assertDirectory(targetRoot, "project registry root");
  const manifestPath = join(targetRoot, "project.json");
  const manifest = await readJson(manifestPath, "Project manifest");
  try {
    assertProjectIdentity(manifest, {
      clientId,
      projectId: formatProjectId(clientId, videoNumber),
      videoNumber,
    });
  } catch (error) {
    throw new Error(`Invalid project manifest at ${manifestPath}: ${error.message}`);
  }

  const layout = projectLayout(clientId, videoNumber);
  assertExpectedStorage(manifest, layout);
  for (const field of ["project_root", "jobs_root", "audio_root", "masters_root"]) {
    await assertSafeWorkspacePath(
      workspaceRoot,
      join(workspaceRoot, manifest.storage[field]),
      `project storage.${field}`,
    );
  }

  if (manifest.storage.mode === "legacy_alias") {
    await assertRecognizableLegacyProject(
      workspaceRoot,
      join(workspaceRoot, manifest.storage.project_root),
    );
  } else {
    for (const directory of PROJECT_DIRECTORIES) {
      await assertDirectory(join(targetRoot, directory), `project ${directory} directory`);
    }
    const variantsPath = join(targetRoot, "variants.json");
    const variants = await readJson(variantsPath, "Variants manifest");
    try {
      validateLegacyVariantsManifest(variants);
      if (variants.project_id !== manifest.project_id) {
        throw new Error(
          `variants project_id ${variants.project_id} does not match ${manifest.project_id}`,
        );
      }
    } catch (error) {
      throw new Error(`Invalid variants manifest at ${variantsPath}: ${error.message}`);
    }
  }
  return manifest;
}

async function listExistingProjects(workspaceRoot, clientId) {
  const registryParent = join(workspaceRoot, "projects", clientId);
  await mkdirSafe(workspaceRoot, registryParent, "client project registry");
  const entries = await readdir(registryParent, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!/^V\d+$/.test(entry.name)) continue;
    const rawNumber = entry.name.slice(1);
    let videoNumber;
    try {
      videoNumber = normalizeVideoNumber(rawNumber);
    } catch (error) {
      throw new Error(
        `Malformed managed project directory ${join(registryParent, entry.name)}: ${error.message}`,
      );
    }
    if (entry.name !== formatVideoDirectory(videoNumber)) {
      throw new Error(
        `Malformed managed project directory name: ${join(registryParent, entry.name)}`,
      );
    }
    const targetRoot = join(registryParent, entry.name);
    const manifest = await validateExistingProject({
      workspaceRoot,
      clientId,
      videoNumber,
      targetRoot,
    });
    projects.push({ videoNumber, manifest, targetRoot });
  }
  return projects.sort((left, right) => left.videoNumber - right.videoNumber);
}

async function writeProjectStaging(stagingRoot, manifest) {
  await writeFile(join(stagingRoot, "project.json"), jsonText(manifest), {
    encoding: "utf8",
    flag: "wx",
  });
  if (manifest.storage.mode === "standard") {
    for (const directory of PROJECT_DIRECTORIES) await mkdir(join(stagingRoot, directory));
    await writeFile(
      join(stagingRoot, "variants.json"),
      jsonText(createVariantsManifest(manifest.project_id)),
      { encoding: "utf8", flag: "wx" },
    );
  }
}

async function createProject({
  workspaceRoot,
  clientId,
  videoNumber,
  title,
  legacyProjectRoot,
  createdAt,
}) {
  const layout = projectLayout(clientId, videoNumber, legacyProjectRoot);
  const targetRoot = join(workspaceRoot, layout.registryRoot);
  const parent = dirname(targetRoot);
  await mkdirSafe(workspaceRoot, parent, "client project registry");
  await assertSafeWorkspacePath(workspaceRoot, targetRoot, "project registry root");

  if (legacyProjectRoot) {
    const legacyAbsolute = join(workspaceRoot, legacyProjectRoot);
    if (resolve(legacyAbsolute) === resolve(targetRoot)) {
      throw new Error("legacy project root cannot be the alias registry root");
    }
    await assertRecognizableLegacyProject(workspaceRoot, legacyAbsolute);
  }

  const manifest = createProjectManifest({
    clientId,
    videoNumber,
    title: title ?? `Видео №${videoNumber}`,
    createdAt,
    storage: layout.storage,
  });
  const stagingRoot = join(
    parent,
    `.${layout.videoDirectory}.bootstrap-${process.pid}-${randomUUID()}`,
  );
  let ownsStaging = false;
  try {
    await assertSafeWorkspacePath(workspaceRoot, stagingRoot, "project staging directory");
    await mkdir(stagingRoot);
    ownsStaging = true;
    await writeProjectStaging(stagingRoot, manifest);
    try {
      await rename(stagingRoot, targetRoot);
      ownsStaging = false;
      return { created: true, manifest, layout };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      return { created: false, manifest: null, layout };
    }
  } finally {
    if (ownsStaging) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function ensureArtifactRoots(workspaceRoot, manifest) {
  for (const field of ["jobs_root", "audio_root", "masters_root"]) {
    await mkdirSafe(
      workspaceRoot,
      join(workspaceRoot, manifest.storage[field]),
      `project ${field}`,
    );
  }
}

function normalizeMode(value) {
  const mode = value ?? "ensure";
  if (!MODES.has(mode)) throw new RangeError("mode must be one of: ensure, new, resume");
  return mode;
}

function timestamp(value) {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}

export async function bootstrapProduction({
  workspaceRoot: requestedWorkspaceRoot,
  clientId: rawClientId,
  clientName: rawClientName,
  videoNumber: rawVideoNumber,
  next = false,
  mode: rawMode,
  title,
  legacyProjectRoot: rawLegacyProjectRoot,
  now,
} = {}) {
  const workspaceRoot = await resolveWorkspaceRoot(requestedWorkspaceRoot, MODULE_WORKSPACE_ROOT);
  const clientId = normalizeClientId(rawClientId);
  const clientName = rawClientName === undefined ? undefined : normalizeClientName(rawClientName);
  const mode = normalizeMode(rawMode);
  if ((rawVideoNumber === undefined) === !next) {
    throw new TypeError("Provide exactly one of videoNumber and next=true");
  }
  if (next && mode === "resume") {
    throw new TypeError("mode=resume cannot be combined with next=true");
  }
  const exactVideoNumber = next ? null : normalizeVideoNumber(rawVideoNumber);
  const legacyProjectRoot = rawLegacyProjectRoot === undefined
    ? null
    : normalizeWorkspaceRelativePath(rawLegacyProjectRoot, "legacy_project_root");
  const createdAt = timestamp(now);

  const client = await ensureClient({ workspaceRoot, clientId, clientName, createdAt });
  await mkdirSafe(workspaceRoot, join(workspaceRoot, "projects"), "projects root");
  await mkdirSafe(workspaceRoot, join(workspaceRoot, "artifacts"), "artifacts root");
  const warnings = [
    ...(client.warning ? [client.warning] : []),
    ...(await preservedStagingWarnings(workspaceRoot, clientId)),
  ];

  if (!next) {
    const layout = projectLayout(clientId, exactVideoNumber, legacyProjectRoot);
    const targetRoot = join(workspaceRoot, layout.registryRoot);
    if (await exists(targetRoot)) {
      const manifest = await validateExistingProject({
        workspaceRoot,
        clientId,
        videoNumber: exactVideoNumber,
        targetRoot,
      });
      if (mode === "new") {
        throw new Error(
          `Project ${manifest.project_id} already exists: ${join(targetRoot, "project.json")}`,
        );
      }
      if (legacyProjectRoot && manifest.storage.project_root !== legacyProjectRoot) {
        throw new Error(
          `Legacy project root conflict for ${manifest.project_id}: expected ${legacyProjectRoot}, found ${manifest.storage.project_root}`,
        );
      }
      await ensureArtifactRoots(workspaceRoot, manifest);
      return contextFromManifest(manifest, "reused", layout.registryRoot, warnings);
    }
    if (mode === "resume") {
      throw new Error(
        `Project ${formatProjectId(clientId, exactVideoNumber)} does not exist: ${join(targetRoot, "project.json")}`,
      );
    }

    const created = await createProject({
      workspaceRoot,
      clientId,
      videoNumber: exactVideoNumber,
      title,
      legacyProjectRoot,
      createdAt,
    });
    if (!created.created) {
      const manifest = await validateExistingProject({
        workspaceRoot,
        clientId,
        videoNumber: exactVideoNumber,
        targetRoot,
      });
      if (mode === "new") {
        throw new Error(
          `Project ${manifest.project_id} already exists: ${join(targetRoot, "project.json")}`,
        );
      }
      if (legacyProjectRoot && manifest.storage.project_root !== legacyProjectRoot) {
        throw new Error(
          `Legacy project root conflict for ${manifest.project_id}: expected ${legacyProjectRoot}, found ${manifest.storage.project_root}`,
        );
      }
      await ensureArtifactRoots(workspaceRoot, manifest);
      return contextFromManifest(manifest, "reused", layout.registryRoot, warnings);
    }
    await ensureArtifactRoots(workspaceRoot, created.manifest);
    return contextFromManifest(
      created.manifest,
      "created",
      created.layout.registryRoot,
      warnings,
    );
  }

  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const projects = await listExistingProjects(workspaceRoot, clientId);
    const highest = projects.at(-1)?.videoNumber ?? 0;
    if (highest >= MAX_VIDEO_NUMBER) {
      throw new RangeError(`Cannot allocate another video after ${MAX_VIDEO_NUMBER}`);
    }
    const videoNumber = highest + 1;
    const created = await createProject({
      workspaceRoot,
      clientId,
      videoNumber,
      title,
      legacyProjectRoot,
      createdAt,
    });
    if (!created.created) continue;
    await ensureArtifactRoots(workspaceRoot, created.manifest);
    return contextFromManifest(
      created.manifest,
      "created",
      created.layout.registryRoot,
      warnings,
    );
  }
  throw new Error(
    `Could not allocate the next project after ${MAX_ALLOCATION_ATTEMPTS} concurrent conflicts; retry the bootstrap command`,
  );
}
