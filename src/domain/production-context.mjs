const CLIENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*-V\d{3,6}$/;
const STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SECRET_TEXT_PATTERN =
  /(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bearer|cookie|signed[_ -]?url)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{16,}|https?:\/\/\S+[?&](?:token|key|signature|x-amz-signature)=)/i;

export const PRODUCTION_SCHEMA_VERSION = 1;
/** Optional audit trail on approval: who approved the budget, when, and why. */
export const APPROVAL_AUDIT_FIELDS = Object.freeze([
  "approved_by",
  "approved_at",
  "note",
  // A named, per-shot exemption from the shot-plan gate for work that was
  // already shot before the gate existed. Never created by the bootstrap: an
  // absent waiver means the gate applies, so the default fails closed.
  "script_plan_waiver",
]);
export const MAX_CLIENT_ID_LENGTH = 64;
export const MAX_VIDEO_NUMBER = 999_999;

function assertRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertExactKeys(value, keys, name) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`${name}.${key} is required`);
  }
}

/**
 * Like assertExactKeys, but tolerates a declared set of optional fields.
 * Manifests written before an optional field existed stay valid, so adding an
 * audit field is not a breaking change for projects already on disk.
 */
function assertKnownKeys(value, required, optional, name) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${name}.${key} is required`);
  }
}

function normalizeText(value, name, { max = 200, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new RangeError(`${name} must be at most ${max} characters`);
  if (/\p{Cc}/u.test(normalized)) throw new TypeError(`${name} must not contain control characters`);
  if (SECRET_TEXT_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must not contain tokens, keys, cookies, or signed URLs`);
  }
  return normalized;
}

function assertNullableText(value, name, options) {
  if (value === null) return;
  normalizeText(value, name, options);
}

function assertStringArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  value.forEach((item, index) => normalizeText(item, `${name}[${index}]`, { max: 1_000 }));
}

function assertTimestamp(value, name) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`${name} must be an ISO 8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  const canonical = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  const normalizedValue = value.length === 20 ? value.replace("Z", ".000Z") : value;
  if (canonical === null || canonical !== normalizedValue) {
    throw new TypeError(`${name} must be an ISO 8601 UTC timestamp`);
  }
}

export function normalizeClientId(value) {
  if (typeof value !== "string") throw new TypeError("client_id must be a string");
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLIENT_ID_LENGTH ||
    !CLIENT_ID_PATTERN.test(normalized)
  ) {
    throw new TypeError(
      `client_id must be 1-${MAX_CLIENT_ID_LENGTH} lowercase ASCII letters, numbers, or single hyphens`,
    );
  }
  return normalized;
}

export function normalizeClientName(value) {
  return normalizeText(value, "client_name", { max: 120 });
}

export function normalizeVideoNumber(value) {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new RangeError(`video_number must be an integer from 1 to ${MAX_VIDEO_NUMBER}`);
  }
  const normalized = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_VIDEO_NUMBER) {
    throw new RangeError(`video_number must be an integer from 1 to ${MAX_VIDEO_NUMBER}`);
  }
  return normalized;
}

export function formatVideoDirectory(videoNumber) {
  return `V${String(normalizeVideoNumber(videoNumber)).padStart(3, "0")}`;
}

export function formatProjectId(clientId, videoNumber) {
  return `${normalizeClientId(clientId).toUpperCase()}-${formatVideoDirectory(videoNumber)}`;
}

export function normalizeWorkspaceRelativePath(value, name = "path") {
  const normalized = normalizeText(value, name, { max: 1_024 });
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${name} must be a normalized relative workspace path`);
  }
  return normalized;
}

export function createClientManifest({ clientId, clientName, createdAt = new Date().toISOString() }) {
  const manifest = {
    schema_version: PRODUCTION_SCHEMA_VERSION,
    client_id: normalizeClientId(clientId),
    display_name: normalizeClientName(clientName),
    created_at: createdAt,
    storage_policy: "local_only",
    defaults: {
      language: null,
      platforms: [],
      cta: null,
    },
    rights: {
      status: "pending",
      notes: [],
    },
    constraints: [],
  };
  return validateClientManifest(manifest);
}

export function validateClientManifest(manifest) {
  assertRecord(manifest, "client manifest");
  assertExactKeys(
    manifest,
    [
      "schema_version",
      "client_id",
      "display_name",
      "created_at",
      "storage_policy",
      "defaults",
      "rights",
      "constraints",
    ],
    "client manifest",
  );
  if (manifest.schema_version !== PRODUCTION_SCHEMA_VERSION) {
    throw new RangeError(`client manifest schema_version must be ${PRODUCTION_SCHEMA_VERSION}`);
  }
  normalizeClientId(manifest.client_id);
  normalizeClientName(manifest.display_name);
  assertTimestamp(manifest.created_at, "client manifest.created_at");
  if (manifest.storage_policy !== "local_only") {
    throw new RangeError("client manifest.storage_policy must be local_only");
  }

  assertRecord(manifest.defaults, "client manifest.defaults");
  assertExactKeys(manifest.defaults, ["language", "platforms", "cta"], "client manifest.defaults");
  assertNullableText(manifest.defaults.language, "client manifest.defaults.language", { max: 32 });
  assertStringArray(manifest.defaults.platforms, "client manifest.defaults.platforms");
  assertNullableText(manifest.defaults.cta, "client manifest.defaults.cta", { max: 500 });

  assertRecord(manifest.rights, "client manifest.rights");
  assertExactKeys(manifest.rights, ["status", "notes"], "client manifest.rights");
  if (typeof manifest.rights.status !== "string" || !STATUS_PATTERN.test(manifest.rights.status)) {
    throw new TypeError("client manifest.rights.status must be a stable lowercase status");
  }
  assertStringArray(manifest.rights.notes, "client manifest.rights.notes");
  assertStringArray(manifest.constraints, "client manifest.constraints");
  return manifest;
}

export function createProjectManifest({
  clientId,
  videoNumber,
  title,
  createdAt = new Date().toISOString(),
  storage,
}) {
  const normalizedClientId = normalizeClientId(clientId);
  const normalizedVideoNumber = normalizeVideoNumber(videoNumber);
  const manifest = {
    schema_version: PRODUCTION_SCHEMA_VERSION,
    client_id: normalizedClientId,
    project_id: formatProjectId(normalizedClientId, normalizedVideoNumber),
    video_number: normalizedVideoNumber,
    title: normalizeText(title, "title", { max: 200 }),
    status: "planning",
    created_at: createdAt,
    approval: {
      paid_generation: false,
      max_total_cost: null,
    },
    rights: {
      status: "pending",
      notes: [],
    },
    storage,
  };
  return validateProjectManifest(manifest);
}

export function validateProjectManifest(manifest) {
  assertRecord(manifest, "project manifest");
  assertExactKeys(
    manifest,
    [
      "schema_version",
      "client_id",
      "project_id",
      "video_number",
      "title",
      "status",
      "created_at",
      "approval",
      "rights",
      "storage",
    ],
    "project manifest",
  );
  if (manifest.schema_version !== PRODUCTION_SCHEMA_VERSION) {
    throw new RangeError(`project manifest schema_version must be ${PRODUCTION_SCHEMA_VERSION}`);
  }
  const clientId = normalizeClientId(manifest.client_id);
  const videoNumber = normalizeVideoNumber(manifest.video_number);
  if (
    typeof manifest.project_id !== "string" ||
    !PROJECT_ID_PATTERN.test(manifest.project_id) ||
    manifest.project_id !== formatProjectId(clientId, videoNumber)
  ) {
    throw new TypeError("project manifest.project_id does not match client_id and video_number");
  }
  normalizeText(manifest.title, "project manifest.title", { max: 200 });
  if (typeof manifest.status !== "string" || !STATUS_PATTERN.test(manifest.status)) {
    throw new TypeError("project manifest.status must be a stable lowercase status");
  }
  assertTimestamp(manifest.created_at, "project manifest.created_at");

  assertRecord(manifest.approval, "project manifest.approval");
  assertKnownKeys(
    manifest.approval,
    ["paid_generation", "max_total_cost"],
    APPROVAL_AUDIT_FIELDS,
    "project manifest.approval",
  );
  if (typeof manifest.approval.paid_generation !== "boolean") {
    throw new TypeError("project manifest.approval.paid_generation must be a boolean");
  }
  if (manifest.approval.approved_by !== undefined) {
    normalizeText(manifest.approval.approved_by, "project manifest.approval.approved_by", {
      max: 120,
    });
  }
  if (manifest.approval.approved_at !== undefined) {
    assertTimestamp(manifest.approval.approved_at, "project manifest.approval.approved_at");
  }
  if (manifest.approval.note !== undefined) {
    normalizeText(manifest.approval.note, "project manifest.approval.note", { max: 1_000 });
  }
  if (manifest.approval.script_plan_waiver !== undefined) {
    const waiver = manifest.approval.script_plan_waiver;
    assertRecord(waiver, "project manifest.approval.script_plan_waiver");
    assertExactKeys(
      waiver,
      ["reason", "waived_by", "waived_at", "shot_ids"],
      "project manifest.approval.script_plan_waiver",
    );
    normalizeText(waiver.reason, "project manifest.approval.script_plan_waiver.reason", { max: 1_000 });
    normalizeText(waiver.waived_by, "project manifest.approval.script_plan_waiver.waived_by", { max: 120 });
    assertTimestamp(waiver.waived_at, "project manifest.approval.script_plan_waiver.waived_at");
    assertStringArray(waiver.shot_ids, "project manifest.approval.script_plan_waiver.shot_ids");
    if (waiver.shot_ids.length === 0) {
      // A blanket waiver would be a hole; every exempt shot is named.
      throw new TypeError(
        "project manifest.approval.script_plan_waiver.shot_ids must name at least one shot",
      );
    }
  }
  if (
    manifest.approval.max_total_cost !== null &&
    (typeof manifest.approval.max_total_cost !== "number" ||
      !Number.isFinite(manifest.approval.max_total_cost) ||
      manifest.approval.max_total_cost < 0)
  ) {
    throw new TypeError("project manifest.approval.max_total_cost must be null or non-negative");
  }

  assertRecord(manifest.rights, "project manifest.rights");
  assertExactKeys(manifest.rights, ["status", "notes"], "project manifest.rights");
  if (typeof manifest.rights.status !== "string" || !STATUS_PATTERN.test(manifest.rights.status)) {
    throw new TypeError("project manifest.rights.status must be a stable lowercase status");
  }
  assertStringArray(manifest.rights.notes, "project manifest.rights.notes");

  assertRecord(manifest.storage, "project manifest.storage");
  assertExactKeys(
    manifest.storage,
    ["mode", "project_root", "jobs_root", "audio_root", "masters_root"],
    "project manifest.storage",
  );
  if (!["standard", "legacy_alias"].includes(manifest.storage.mode)) {
    throw new RangeError("project manifest.storage.mode must be standard or legacy_alias");
  }
  for (const field of ["project_root", "jobs_root", "audio_root", "masters_root"]) {
    normalizeWorkspaceRelativePath(manifest.storage[field], `project manifest.storage.${field}`);
  }
  return manifest;
}

export function assertClientIdentity(manifest, { clientId, clientName } = {}) {
  validateClientManifest(manifest);
  if (clientId !== undefined && manifest.client_id !== normalizeClientId(clientId)) {
    throw new Error(
      `Client identity conflict: expected ${normalizeClientId(clientId)}, found ${manifest.client_id}`,
    );
  }
  if (clientName !== undefined) {
    const requested = normalizeClientName(clientName);
    // A different capitalisation of the same name is the same client, not a
    // conflict: refusing to work over "LidFly" vs "Lidfly" blocks the bootstrap
    // for no reason. A genuinely different name still fails closed.
    if (
      manifest.display_name !== requested &&
      manifest.display_name.toLocaleLowerCase() !== requested.toLocaleLowerCase()
    ) {
      throw new Error(
        `Client display name conflict for ${manifest.client_id}: expected ${requested}, found ${manifest.display_name}`,
      );
    }
  }
  return manifest;
}

/**
 * Report a capitalisation-only difference between the stored client name and the
 * requested one. The stored name stays authoritative — the bootstrap never
 * renames a client silently — so this is surfaced as a warning.
 */
export function clientNameCaseWarning(manifest, clientName) {
  if (clientName === undefined) return null;
  const requested = normalizeClientName(clientName);
  if (manifest.display_name === requested) return null;
  if (manifest.display_name.toLocaleLowerCase() !== requested.toLocaleLowerCase()) return null;
  return `client display name differs only in case: stored ${manifest.display_name}, requested ${requested}; the stored name is kept`;
}

export function assertProjectIdentity(manifest, { clientId, projectId, videoNumber } = {}) {
  validateProjectManifest(manifest);
  const expected = {
    ...(clientId === undefined ? {} : { client_id: normalizeClientId(clientId) }),
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(videoNumber === undefined ? {} : { video_number: normalizeVideoNumber(videoNumber) }),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      throw new Error(
        `Project identity conflict in ${field}: expected ${value}, found ${manifest[field]}`,
      );
    }
  }
  return manifest;
}

export function createVariantsManifest(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new TypeError("project_id must be a production project ID");
  }
  return {
    schema_version: PRODUCTION_SCHEMA_VERSION,
    project_id: projectId,
    versioning_policy: {
      scheme: "B1, B2, B3, ...",
      monotonic: true,
      reuse_forbidden: true,
      retention:
        "keep all generated, rejected, partial, superseded, intermediate and selected artifacts until explicit user-approved cleanup",
    },
    variants: [],
  };
}

export function validateLegacyVariantsManifest(manifest) {
  assertRecord(manifest, "legacy variants manifest");
  if (manifest.schema_version !== PRODUCTION_SCHEMA_VERSION) {
    throw new RangeError(`legacy variants manifest schema_version must be ${PRODUCTION_SCHEMA_VERSION}`);
  }
  normalizeText(manifest.project_id, "legacy variants manifest.project_id", { max: 200 });
  assertRecord(manifest.versioning_policy, "legacy variants manifest.versioning_policy");
  if (
    manifest.versioning_policy.monotonic !== true ||
    manifest.versioning_policy.reuse_forbidden !== true
  ) {
    throw new TypeError("legacy variants manifest must enforce monotonic, non-reusable variants");
  }
  if (!Array.isArray(manifest.variants)) {
    throw new TypeError("legacy variants manifest.variants must be an array");
  }
  return manifest;
}

export function productionContextFromManifest(manifest, action, registryRoot, warnings = []) {
  return {
    schema_version: 1,
    action,
    client_id: manifest.client_id,
    project_id: manifest.project_id,
    video_number: manifest.video_number,
    project_manifest_path: `${registryRoot}/project.json`,
    project_root: manifest.storage.project_root,
    jobs_root: manifest.storage.jobs_root,
    audio_root: manifest.storage.audio_root,
    masters_root: manifest.storage.masters_root,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

export function productionMetadata(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("production context must be an object");
  }
  const unsupported = Object.keys(context).filter(
    (field) => !["client_id", "project_id", "video_number"].includes(field),
  );
  if (unsupported.length) {
    throw new TypeError(`production context has unsupported field: ${unsupported[0]}`);
  }
  const projectId = formatProjectId(context.client_id, context.video_number);
  if (context.project_id !== projectId) {
    throw new TypeError(
      `production context project_id must be ${projectId}, found ${context.project_id ?? "missing"}`,
    );
  }
  return {
    production: {
      client_id: normalizeClientId(context.client_id),
      project_id: projectId,
      video_number: normalizeVideoNumber(context.video_number),
    },
  };
}
