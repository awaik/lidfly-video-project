import { constants } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashFile } from "../core/hashing.mjs";
import { assertSafeWorkspacePath, mkdirSafe, readJson } from "../core/workspace-files.mjs";
import { identifier, requiredString } from "../core/validation.mjs";
import { normalizeShotPlan } from "../domain/shot-plan.mjs";
import { normalizeContinuity } from "../domain/continuity.mjs";
import { composeShotPrompt } from "../domain/shot-prompt.mjs";
import { probeMedia } from "../media/ffmpeg.mjs";
import { resolveProjectRegistry } from "./asset-registry.mjs";
import { shotPlanStatus } from "./shot-plan.mjs";

function geminiUrl(value) {
  const url = new URL(requiredString(value, "receipt.result_url"));
  if (url.protocol !== "https:" || url.hostname !== "gemini.google.com" || url.username || url.password) {
    throw new Error("result_url must be a Gemini page, not a signed download URL");
  }
  return url.href;
}

/** Local ingestion only. This command never submits a prompt or accepts a take. */
export async function importBrowserTake({ projectRoot, workspaceRoot, requestPath, receiptPath, filePath }, tools = { probeMedia }) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  const status = await shotPlanStatus({ projectRoot, workspaceRoot });
  if (!status.gate_ready) throw new Error("Browser import requires an unchanged frozen shot plan and continuity");
  const request = await readJson(resolve(requestPath), "Browser request");
  const receipt = await readJson(resolve(receiptPath), "Browser receipt");
  if (request.schema_version !== "browser-request/1" || request.provider !== "gemini-browser") {
    throw new Error("Expected a composed browser-request/1 request");
  }
  const identity = request.metadata?.production;
  for (const key of ["client_id", "project_id", "video_number"]) {
    if (identity?.[key] !== project.manifest[key]) throw new Error(`Browser request ${key} mismatch`);
  }
  if (request.metadata?.script?.plan_hash !== status.plan_hash) throw new Error("Browser request plan hash mismatch");
  const shotId = identifier(request.shot_id, "shot_id");
  if (!/^B[1-9]\d*$/.test(request.take_id)) throw new Error("Browser take_id must be B1, B2, ...");
  const plan = normalizeShotPlan(await readJson(join(project.registryRoot, "brief/shotplan.json"), "Shot plan"));
  const continuity = normalizeContinuity(await readJson(join(project.registryRoot, "brief/continuity.json"), "Continuity"));
  const shot = plan.shots.find((item) => item.shot_id === shotId && item.source === "generated");
  if (!shot || shot.route.model !== "gemini-browser") throw new Error("Shot is not routed to Gemini browser in the frozen plan");
  if (request.prompt !== composeShotPrompt({ plan, continuity, shot }).prompt ||
      request.model !== "gemini-browser" || request.mode !== shot.route.mode ||
      request.duration_seconds !== shot.duration_seconds || request.aspect_ratio !== plan.target.aspect_ratio ||
      request.resolution !== plan.target.resolution_default || request.generate_audio !== false) {
    throw new Error("Browser request differs from the frozen shot");
  }
  const references = request.references ?? [];
  if (JSON.stringify(references.map((ref) => ref.asset_id)) !== JSON.stringify(shot.identity_refs)) {
    throw new Error("Browser reference IDs differ from the frozen shot");
  }
  for (const reference of references) {
    if (reference.rights_status !== "approved" || !reference.sha256 ||
        await hashFile(reference.path) !== reference.sha256) {
      throw new Error(`Browser reference rights/hash mismatch: ${reference.asset_id}`);
    }
  }
  const requestHash = await hashFile(resolve(requestPath));
  if (receipt.request_sha256 !== requestHash) throw new Error("Receipt request hash mismatch");
  if (receipt.status !== "completed") throw new Error("Only a completed browser result can be imported");
  const resultUrl = geminiUrl(receipt.result_url);
  for (const key of ["profile", "model_label", "submitted_at", "completed_at", "cost_note", "authorization_note", "settings_note"]) {
    requiredString(receipt[key], `receipt.${key}`);
  }
  const source = resolve(filePath);
  const measured = await tools.probeMedia(source);
  if (!measured.video || !(measured.duration_seconds > 0)) throw new Error("Downloaded file has no usable video stream");
  const sourceHash = await hashFile(source);
  const root = resolve(project.workspaceRoot, project.manifest.storage.jobs_root, "browser", shotId);
  await mkdirSafe(project.workspaceRoot, root, "browser takes root");
  const versions = (await readdir(root)).map((name) => /^B([1-9]\d*)$/.exec(name)).filter(Boolean).map((match) => Number(match[1]));
  if (Number(request.take_id.slice(1)) <= Math.max(0, ...versions)) throw new Error("Browser take version must increase; preserve earlier attempts");
  const directory = join(root, request.take_id);
  await assertSafeWorkspacePath(project.workspaceRoot, directory, "browser take");
  await mkdir(directory); // Exclusive allocation; concurrent imports cannot overwrite a take.
  await copyFile(resolve(requestPath), join(directory, "request.json"), constants.COPYFILE_EXCL);
  await copyFile(resolve(receiptPath), join(directory, "receipt.json"), constants.COPYFILE_EXCL);
  if (await hashFile(join(directory, "request.json")) !== requestHash) {
    throw new Error("Request changed while importing; partial take preserved");
  }
  const output = join(directory, "original.mp4");
  await copyFile(source, output, constants.COPYFILE_EXCL);
  if (await hashFile(output) !== sourceHash) throw new Error("Source changed while importing; partial take preserved");
  const manifest = {
    schema_version: "browser-take/1", status: "review_required", route: "browser",
    shot_id: shotId, take_id: request.take_id, metadata: request.metadata,
    provider: "gemini-browser", model_label: receipt.model_label, result_url: resultUrl,
    request_sha256: requestHash, receipt_sha256: await hashFile(join(directory, "receipt.json")),
    source_path: source, source_sha256: sourceHash, output, measured,
    imported_at: new Date().toISOString(),
    audio_disposition: "exclude_native_audio; separate audio production required",
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { directory, ...manifest };
}
