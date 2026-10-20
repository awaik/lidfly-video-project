import { createHash } from "node:crypto";
import {
  assertNoUnknownKeys,
  assertObject,
  identifier,
  oneOf,
  optionalString,
} from "../core/validation.mjs";
import { REFERENCE_ROLES } from "./video-request.mjs";
import { aspectRatioMatches, formatAspectRatio, parseAspectRatio } from "./aspect-ratio.mjs";

// Re-exported so existing importers keep one import site while the maths lives
// in a single module shared with the assembler and the shot-plan gate.
export { aspectRatioMatches, formatAspectRatio, parseAspectRatio };

export const ASSET_SCHEMA_VERSION = 1;
export const RIGHTS_STATUSES = ["approved", "not_required"];

/** Formats are detected from magic bytes, never from the filename the user happened to give us. */
export const IMAGE_FORMATS = Object.freeze({
  jpeg: Object.freeze({ extension: ".jpg", mime_type: "image/jpeg" }),
  png: Object.freeze({ extension: ".png", mime_type: "image/png" }),
  webp: Object.freeze({ extension: ".webp", mime_type: "image/webp" }),
});

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Short side below this reads as an identity-drift risk rather than an API rejection. */
export const MIN_RECOMMENDED_SHORT_SIDE = 1024;

const ASSET_FIELDS = new Set([
  "asset_id",
  "role",
  "path",
  "format",
  "mime_type",
  "width",
  "height",
  "aspect_ratio",
  "size_bytes",
  "sha256",
  "rights_status",
  "note",
  "added_at",
  // Retirement is a note in the registry, never a deleted file: the original
  // stays exactly where the user's copy landed.
  "status",
  "superseded_by",
  "status_note",
  "status_changed_at",
]);

export const ASSET_STATUSES = Object.freeze(["active", "superseded", "unused"]);

function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return null;
  }
  let index = 2;
  while (index + 3 < buffer.length) {
    if (buffer[index] !== 0xff) return null;
    let marker = buffer[index + 1];
    while (marker === 0xff && index + 2 < buffer.length) {
      index += 1;
      marker = buffer[index + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(index + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (index + 9 > buffer.length) return null;
      return {
        format: "jpeg",
        height: buffer.readUInt16BE(index + 5),
        width: buffer.readUInt16BE(index + 7),
      };
    }
    index += 2 + length;
  }
  return null;
}

function readWebpSize(buffer) {
  if (
    buffer.length < 30 ||
    buffer.toString("latin1", 0, 4) !== "RIFF" ||
    buffer.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = buffer.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return {
      format: "webp",
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      format: "webp",
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  return null;
}

/**
 * Identify a reference image from its contents. Returns null for anything we cannot prove is a
 * supported still image, so HEIC, AVIF, PDF, or video renamed to `.jpg` never reaches a provider.
 */
export function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("image contents must be a Buffer");
  const detected = readPngSize(buffer) ?? readJpegSize(buffer) ?? readWebpSize(buffer);
  if (!detected || !Number.isInteger(detected.width) || !Number.isInteger(detected.height)) {
    return null;
  }
  if (detected.width < 1 || detected.height < 1) return null;
  return { ...detected, ...IMAGE_FORMATS[detected.format] };
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeAssetId(value) {
  const normalized = identifier(value, "asset_id");
  if (normalized.startsWith(".") || normalized.includes("/") || normalized.includes("\\")) {
    throw new TypeError("asset_id must not describe a path");
  }
  return normalized;
}

export function normalizeRole(value) {
  return oneOf(value, "role", REFERENCE_ROLES);
}

export function normalizeRightsStatus(value) {
  return oneOf(value, "rights_status", RIGHTS_STATUSES);
}

export function createAssetsManifest(projectId) {
  return {
    schema_version: ASSET_SCHEMA_VERSION,
    project_id: projectId,
    policy: {
      originals_immutable: true,
      retention:
        "keep every ingested reference original until explicit user-approved cleanup; never overwrite an asset_id",
    },
    assets: [],
  };
}

export function validateAssetRecord(record, index = 0) {
  const label = `assets[${index}]`;
  assertObject(record, label);
  assertNoUnknownKeys(record, ASSET_FIELDS, label);
  normalizeAssetId(record.asset_id);
  normalizeRole(record.role);
  normalizeRightsStatus(record.rights_status);
  if (typeof record.path !== "string" || !record.path.startsWith("assets/originals/")) {
    throw new TypeError(`${label}.path must stay inside assets/originals/`);
  }
  if (!Object.hasOwn(IMAGE_FORMATS, record.format)) {
    throw new RangeError(`${label}.format must be one of: ${Object.keys(IMAGE_FORMATS).join(", ")}`);
  }
  for (const field of ["width", "height", "size_bytes"]) {
    if (!Number.isInteger(record[field]) || record[field] < 1) {
      throw new TypeError(`${label}.${field} must be a positive integer`);
    }
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new TypeError(`${label}.sha256 must be a sha256 digest`);
  }
  optionalString(record.note, `${label}.note`, { max: 500 });
  if (record.status !== undefined) {
    if (!ASSET_STATUSES.includes(record.status)) {
      throw new RangeError(`${label}.status must be one of: ${ASSET_STATUSES.join(", ")}`);
    }
    if (record.status !== "active") {
      // Retiring something without saying why is how a registry becomes folklore.
      if (!record.status_note) throw new TypeError(`${label}.status_note is required for a non-active asset`);
      optionalString(record.status_note, `${label}.status_note`, { max: 500 });
    }
    if (record.status === "superseded") {
      if (!record.superseded_by) {
        throw new TypeError(`${label}.superseded_by is required when status is superseded`);
      }
      normalizeAssetId(record.superseded_by);
      if (record.superseded_by === record.asset_id) {
        throw new TypeError(`${label}.superseded_by cannot point at itself`);
      }
    }
  } else if (record.superseded_by !== undefined || record.status_note !== undefined) {
    throw new TypeError(`${label}.status is required when a retirement note is present`);
  }
  return record;
}

/** An asset with no explicit status is active; that keeps old registries valid. */
export function assetStatus(record) {
  return record.status ?? "active";
}

export function validateAssetsManifest(manifest) {
  assertObject(manifest, "assets manifest");
  assertNoUnknownKeys(
    manifest,
    new Set(["schema_version", "project_id", "policy", "assets"]),
    "assets manifest",
  );
  if (manifest.schema_version !== ASSET_SCHEMA_VERSION) {
    throw new RangeError(`assets manifest schema_version must be ${ASSET_SCHEMA_VERSION}`);
  }
  if (typeof manifest.project_id !== "string" || manifest.project_id.trim().length === 0) {
    throw new TypeError("assets manifest.project_id is required");
  }
  assertObject(manifest.policy, "assets manifest.policy");
  if (manifest.policy.originals_immutable !== true) {
    throw new TypeError("assets manifest.policy.originals_immutable must stay true");
  }
  if (!Array.isArray(manifest.assets)) throw new TypeError("assets manifest.assets must be an array");
  const ids = new Set();
  manifest.assets.forEach((record, index) => {
    validateAssetRecord(record, index);
    if (ids.has(record.asset_id)) throw new TypeError(`duplicate asset_id: ${record.asset_id}`);
    ids.add(record.asset_id);
  });
  const byId = new Map(manifest.assets.map((record) => [record.asset_id, record]));
  for (const record of manifest.assets) {
    if (record.status !== "superseded") continue;
    const replacement = byId.get(record.superseded_by);
    if (!replacement) {
      throw new TypeError(`${record.asset_id}.superseded_by points at an asset that is not in the registry`);
    }
    if (assetStatus(replacement) !== "active") {
      throw new TypeError(`${record.asset_id}.superseded_by must point at an active asset`);
    }
  }
  return manifest;
}

/**
 * Creative-quality observations that no provider schema catches: too small to hold a face,
 * framed against the wrong output ratio, or the same file ingested twice under two roles.
 */
export function assetQualityFindings(
  asset,
  { aspectRatio = null, targetAspectRatio = null, duplicateOf = null } = {},
) {
  const findings = [];
  if (asset.role === "identity" && asset.rights_status === "not_required") {
    findings.push({
      level: "warning",
      code: "identity_rights_unconfirmed",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: identity помечен как not_required — перед генерацией подтвердите право использовать лицо или сходство`,
    });
  }
  const shortSide = Math.min(asset.width, asset.height);
  if (shortSide < MIN_RECOMMENDED_SHORT_SIDE) {
    findings.push({
      level: "warning",
      code: "low_resolution",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: короткая сторона ${shortSide}px, рекомендуется от ${MIN_RECOMMENDED_SHORT_SIDE}px — риск дрейфа лица и деталей`,
    });
  }
  // An adaptive route has no ratio of its own: it copies the source. The thing
  // worth warning about is the gap between that source and what the project is
  // actually delivering, which is why the target is passed in rather than assumed.
  const adaptiveTarget = targetAspectRatio ?? "9:16";
  if (
    aspectRatio === "adaptive" &&
    !aspectRatioMatches(asset.width, asset.height, adaptiveTarget)
  ) {
    findings.push({
      level: "warning",
      code: "adaptive_aspect_ratio",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: adaptive-выход повторит ориентацию источника ${asset.aspect_ratio}, а не целевые ${adaptiveTarget}`,
    });
  } else if (aspectRatio && !aspectRatioMatches(asset.width, asset.height, aspectRatio)) {
    findings.push({
      level: "warning",
      code: "aspect_ratio_mismatch",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: кадр ${asset.aspect_ratio} при выводе ${aspectRatio} — модель дорисует или обрежет края`,
    });
  }
  if (duplicateOf && assetStatus(asset) === "active") {
    findings.push({
      level: "warning",
      code: "duplicate_content",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: побайтно совпадает с ${duplicateOf} — один и тот же кадр занимает два слота референсов; пометьте лишний через assets retire --status superseded --superseded-by ${duplicateOf}`,
    });
  }
  if (assetStatus(asset) !== "active") {
    findings.push({
      level: "info",
      code: "asset_retired",
      asset_id: asset.asset_id,
      message: `${asset.asset_id}: помечен как ${asset.status} и в проверку ёмкости не входит — ${asset.status_note}`,
    });
  }
  return findings;
}
