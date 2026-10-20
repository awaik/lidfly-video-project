import { assertObject, oneOf, requiredString } from "../core/validation.mjs";

export const ACCEPTING_DECISIONS = Object.freeze(["accept", "accept_with_trim", "accept_with_post", "composite"]);
export const REJECTING_DECISIONS = Object.freeze(["reject", "regenerate", "reroute"]);

/**
 * Validate a take review as it is actually written on disk.
 *
 * Deliberately lenient about unknown fields: these records are written by hand
 * and by agents, and refusing an extra note would make the honest path harder
 * than skipping review altogether. What must be exact is the decision.
 */
export function normalizeReviewRecord(input, label = "review record") {
  assertObject(input, label);
  const decision = oneOf(input.decision, `${label}.decision`, [
    ...ACCEPTING_DECISIONS,
    ...REJECTING_DECISIONS,
  ]);

  let usableRange = null;
  const rawRange = input.usable_range_seconds ?? input.usable_range;
  if (Array.isArray(rawRange) && rawRange.length === 2) {
    const [start, end] = rawRange.map(Number);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) usableRange = [start, end];
  } else if (rawRange && typeof rawRange === "object") {
    const start = Number(rawRange.in_seconds);
    const end = Number(rawRange.out_seconds);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) usableRange = [start, end];
  }

  return {
    shot_id: input.shot_id ?? null,
    take_id: input.take_id ?? null,
    source_path: input.source_path ?? null,
    source_sha256: typeof input.source_sha256 === "string" ? input.source_sha256 : null,
    decision,
    accepts: ACCEPTING_DECISIONS.includes(decision),
    usable_range_seconds: usableRange,
    hard_gates_failed: failedHardGates(input.hard_gates),
    reviewed_at: input.reviewed_at ?? null,
    reviewer: input.reviewer ?? null,
    ...(input.audio_disposition === undefined
      ? {}
      : { audio_disposition: requiredString(input.audio_disposition, `${label}.audio_disposition`, { max: 600 }) }),
  };
}

/**
 * Both shapes seen in real records: a flat map of booleans (with
 * "not_applicable_*" strings) and the { passed, failures[] } form from the QA
 * rubric.
 */
function failedHardGates(gates) {
  if (!gates || typeof gates !== "object") return [];
  if (Array.isArray(gates.failures)) return gates.failures.map(String);
  return Object.entries(gates)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
}
