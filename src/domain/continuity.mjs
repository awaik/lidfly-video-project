import { hashValue } from "../core/hashing.mjs";
import {
  assertNoUnknownKeys,
  assertObject,
  identifier,
  oneOf,
  optionalString,
  requiredString,
} from "../core/validation.mjs";

export const CONTINUITY_SCHEMA_VERSION = 1;

/**
 * Anchor kinds are the properties that must not drift between shots.
 *
 * The `kind.name` id convention already existed in hand-written shot lists
 * (`character.marketer`, `location.home_office`); this only makes it checkable.
 */
export const ANCHOR_KINDS = Object.freeze([
  "light",
  "location",
  "scale",
  "palette",
  "wardrobe",
  "prop",
  "weather",
  "screen_direction",
]);
export const ENTITY_KINDS = Object.freeze(["character", "creature", "product", "location", "vehicle"]);
export const ENTITY_ROLES = Object.freeze(["protagonist", "antagonist", "supporting", "object"]);

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "project_id",
  "global_prompt_block",
  "negative_prompt_block",
  "required_anchor_kinds",
  "anchors",
  "entities",
]);
const ANCHOR_FIELDS = new Set(["kind", "text"]);
const ENTITY_FIELDS = new Set([
  "kind",
  "role",
  "prompt_text",
  "invariants",
  "signature_feature",
  "requires_close_up",
  "identity_assets",
  "scale_anchor",
]);

const ANCHOR_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function createContinuity({ projectId }) {
  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    project_id: requiredString(projectId, "project_id"),
    global_prompt_block: "",
    negative_prompt_block: "",
    required_anchor_kinds: ["light", "location"],
    anchors: {},
    entities: {},
  };
}

function normalizeAnchor(id, raw) {
  const path = `anchors["${id}"]`;
  if (!ANCHOR_ID.test(id)) {
    throw new TypeError(`${path} id must look like kind.name, for example light.copper_evening`);
  }
  assertObject(raw, path);
  assertNoUnknownKeys(raw, ANCHOR_FIELDS, path);
  const kind = oneOf(raw.kind, `${path}.kind`, ANCHOR_KINDS);
  // The prefix carries meaning in every message the checks print, so it may not
  // disagree with the declared kind.
  if (id.split(".")[0] !== kind) {
    throw new TypeError(`${path} id starts with "${id.split(".")[0]}" but declares kind "${kind}"`);
  }
  return { kind, text: requiredString(raw.text, `${path}.text`, { max: 1_000 }) };
}

function normalizeEntity(id, raw) {
  const path = `entities["${id}"]`;
  identifier(id, `${path} id`);
  assertObject(raw, path);
  assertNoUnknownKeys(raw, ENTITY_FIELDS, path);
  const identityAssets = raw.identity_assets ?? [];
  if (!Array.isArray(identityAssets)) throw new TypeError(`${path}.identity_assets must be an array`);
  const invariants = raw.invariants ?? [];
  if (!Array.isArray(invariants)) throw new TypeError(`${path}.invariants must be an array`);
  return {
    kind: oneOf(raw.kind, `${path}.kind`, ENTITY_KINDS),
    role: oneOf(raw.role, `${path}.role`, ENTITY_ROLES, "supporting"),
    prompt_text: requiredString(raw.prompt_text, `${path}.prompt_text`, { max: 2_000 }),
    invariants: invariants.map((value, index) =>
      requiredString(value, `${path}.invariants[${index}]`, { max: 300 }),
    ),
    ...(raw.signature_feature === undefined || raw.signature_feature === null
      ? {}
      : { signature_feature: requiredString(raw.signature_feature, `${path}.signature_feature`, { max: 300 }) }),
    requires_close_up: raw.requires_close_up === undefined ? false : Boolean(raw.requires_close_up),
    identity_assets: identityAssets.map((value, index) =>
      identifier(value, `${path}.identity_assets[${index}]`),
    ),
    scale_anchor:
      raw.scale_anchor === undefined || raw.scale_anchor === null
        ? null
        : requiredString(raw.scale_anchor, `${path}.scale_anchor`),
  };
}

export function normalizeContinuity(input) {
  assertObject(input, "continuity");
  assertNoUnknownKeys(input, TOP_LEVEL_FIELDS, "continuity");
  if ((input.schema_version ?? CONTINUITY_SCHEMA_VERSION) !== CONTINUITY_SCHEMA_VERSION) {
    throw new RangeError(`continuity schema_version must be ${CONTINUITY_SCHEMA_VERSION}`);
  }

  assertObject(input.anchors ?? {}, "continuity.anchors");
  assertObject(input.entities ?? {}, "continuity.entities");
  const anchors = Object.fromEntries(
    Object.entries(input.anchors ?? {}).map(([id, raw]) => [id, normalizeAnchor(id, raw)]),
  );
  const entities = Object.fromEntries(
    Object.entries(input.entities ?? {}).map(([id, raw]) => [id, normalizeEntity(id, raw)]),
  );

  const requiredKinds = input.required_anchor_kinds ?? ["light", "location"];
  if (!Array.isArray(requiredKinds)) {
    throw new TypeError("continuity.required_anchor_kinds must be an array");
  }

  for (const [id, entity] of Object.entries(entities)) {
    if (entity.scale_anchor && !anchors[entity.scale_anchor]) {
      throw new TypeError(
        `entities["${id}"].scale_anchor points at ${entity.scale_anchor}, which is not declared in anchors`,
      );
    }
  }

  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    project_id: requiredString(input.project_id, "continuity.project_id"),
    global_prompt_block: optionalString(input.global_prompt_block, "continuity.global_prompt_block", {
      max: 2_000,
      allowEmpty: true,
    }) ?? "",
    negative_prompt_block:
      optionalString(input.negative_prompt_block, "continuity.negative_prompt_block", {
        max: 1_000,
        allowEmpty: true,
      }) ?? "",
    required_anchor_kinds: requiredKinds.map((value, index) =>
      oneOf(value, `continuity.required_anchor_kinds[${index}]`, ANCHOR_KINDS),
    ),
    anchors,
    entities,
  };
}

/** Hash of the whole continuity document: it carries no envelope of its own. */
export function continuityHash(continuity) {
  return hashValue(normalizeContinuity(continuity));
}

/** The single entity the audience is meant to follow, if the project declares one. */
export function protagonistOf(continuity) {
  const entry = Object.entries(continuity.entities).find(([, entity]) => entity.role === "protagonist");
  return entry ? { id: entry[0], ...entry[1] } : null;
}
