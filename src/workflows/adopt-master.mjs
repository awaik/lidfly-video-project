import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { hashFile } from "../core/hashing.mjs";
import { exists, readJson } from "../core/workspace-files.mjs";
import { identifier, optionalString, requiredString } from "../core/validation.mjs";
import { aspectRatioMatches, formatAspectRatio } from "../domain/aspect-ratio.mjs";
import { countFrames, detectBlackAndFreeze, measureLoudness, probeMedia } from "../media/ffmpeg.mjs";
import { nextMasterVersion } from "./assembly.mjs";
import { projectPathsFromMastersRoot } from "./budget.mjs";

/**
 * Adopt a master rendered by an external editor (OpenChatCut) into a project's
 * masters root with the same guarantees the assembler gives its own output:
 * a new, never-overwritten version, a sha256, the origin that produced it, and
 * measured verification numbers instead of a pass/fail label.
 *
 * The editor keeps its exports in its own profile directory and sweeps stale
 * ones; without this step a delivered master would exist only there, with no
 * record binding it to the project, the frozen plan or the timeline it came from.
 */

export const ADOPTED_MASTER_SCHEMA = "adopted-master/1";
const DEFAULT_TARGET_LUFS = Object.freeze([-20, -16]);
const DEFAULT_TOOLS = { probeMedia, countFrames, measureLoudness, detectBlackAndFreeze };
const VISUAL_KINDS = new Set(["video", "image", "gif", "svg", "motion-graphic"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Read a `read_timeline` snapshot into the shape `scripts/analyse-master.mjs`
 * already understands: ordered segments with frame counts. The base track is
 * the one carrying the most visual frames; gaps between its clips become gap
 * segments so every later start still lands where it does in the master.
 */
export function deriveCutList(timeline) {
  const fps = Number(timeline?.fps);
  const items = Array.isArray(timeline?.items) ? timeline.items : null;
  if (!Number.isFinite(fps) || fps <= 0 || !items) {
    return { fps: null, base_track: null, segments: [], total_frames: null, warnings: ["timeline snapshot lacks fps or items"] };
  }
  const visual = items.filter(
    (item) =>
      VISUAL_KINDS.has(item?.kind) &&
      Number.isInteger(item.startFrame) &&
      item.startFrame >= 0 &&
      Number.isInteger(item.durationInFrames) &&
      item.durationInFrames > 0,
  );
  const totalFrames = items.reduce(
    (max, item) => Math.max(max, (Number(item?.startFrame) || 0) + (Number(item?.durationInFrames) || 0)),
    0,
  );
  if (!visual.length) {
    return { fps, base_track: null, segments: [], total_frames: totalFrames, warnings: ["timeline snapshot has no visual items"] };
  }
  const framesByTrack = new Map();
  for (const item of visual) {
    const track = String(item.trackId ?? "");
    framesByTrack.set(track, (framesByTrack.get(track) ?? 0) + item.durationInFrames);
  }
  const [baseTrack] = [...framesByTrack.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  const ordered = visual
    .filter((item) => String(item.trackId ?? "") === baseTrack)
    .sort((left, right) => left.startFrame - right.startFrame);

  const segments = [];
  const warnings = [];
  let cursor = 0;
  for (const item of ordered) {
    if (item.startFrame < cursor) {
      warnings.push(`overlapping items on track ${baseTrack} at frame ${item.startFrame}; the cut list stops there`);
      break;
    }
    if (item.startFrame > cursor) {
      segments.push({ id: `gap-${cursor}`, kind: "gap", frames: item.startFrame - cursor, start_frame: cursor });
    }
    segments.push({
      id: String(item.id ?? `item-${item.startFrame}`),
      kind: item.kind,
      name: item.name ?? null,
      frames: item.durationInFrames,
      start_frame: item.startFrame,
      source_asset_id: item.sourceAssetId ?? null,
    });
    cursor = item.startFrame + item.durationInFrames;
  }
  return { fps, base_track: baseTrack, segments, total_frames: totalFrames, warnings };
}

function normalizeTargetLufs(value) {
  if (value === undefined || value === null) return [...DEFAULT_TARGET_LUFS];
  const pair = Array.isArray(value) ? value : String(value).split(",");
  if (pair.length !== 2) throw new TypeError("target_lufs must be a [floor, ceiling] pair");
  const [floor, ceiling] = pair.map(Number);
  if (![floor, ceiling].every((entry) => Number.isFinite(entry) && entry >= -40 && entry <= 0)) {
    throw new RangeError("target_lufs values must be numbers from -40 to 0");
  }
  if (floor >= ceiling) throw new RangeError("target_lufs must be ordered [floor, ceiling]");
  return [floor, ceiling];
}

/** Only the local editor may be a download source: a master is not fetched from the internet. */
function assertLocalEditorUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("source url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("source url must be http(s)");
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new TypeError(`source url must point at the local editor, not ${url.hostname}`);
  }
  return url.toString();
}

async function downloadTo(fetchImpl, url, target) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  if (!response.body) throw new Error(`download returned no body: ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: "wx" }));
}

/** A report whose master carries these exact bytes: adopting twice is a no-op, not a new version. */
async function findAdoptedReport(masterDirectory, sha256) {
  let entries = [];
  try {
    entries = await readdir(masterDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of entries.filter((entry) => entry.endsWith(".report.json")).sort().reverse()) {
    let report;
    try {
      report = JSON.parse(await readFile(join(masterDirectory, name), "utf8"));
    } catch {
      continue;
    }
    if (report?.master_sha256 !== sha256) continue;
    if (!(await exists(report.master_path))) continue;
    return report;
  }
  return null;
}

async function readFrozenPlan(mastersRootAbsolute) {
  const paths = projectPathsFromMastersRoot(mastersRootAbsolute);
  if (!paths) return null;
  let plan;
  try {
    plan = JSON.parse(await readFile(paths.shotPlanPath, "utf8"));
  } catch {
    return null;
  }
  return plan?.status === "frozen" && plan?.target ? plan : null;
}

/**
 * Measure the adopted file and compare it with what the project declared:
 * the frozen plan's shape, frame rate and duration, the timeline snapshot's
 * frame count, and the loudness window the finishing standard expects.
 */
export async function verifyAdoptedMaster(masterPath, { tools = DEFAULT_TOOLS, plan = null, cutList = null, targetLufs = DEFAULT_TARGET_LUFS } = {}) {
  const [media, frames, defects] = await Promise.all([
    tools.probeMedia(masterPath),
    tools.countFrames(masterPath),
    tools.detectBlackAndFreeze(masterPath),
  ]);
  const issues = [];
  const warnings = [];
  const planChecks = {};

  if (!media.video) issues.push("master has no video stream");
  if (plan && media.video) {
    const target = plan.target;
    const actualRatio = formatAspectRatio(media.video.width, media.video.height);
    planChecks.aspect_ratio = { plan: target.aspect_ratio ?? null, master: actualRatio };
    if (target.aspect_ratio && target.aspect_ratio !== "adaptive" && !aspectRatioMatches(media.video.width, media.video.height, target.aspect_ratio)) {
      issues.push(`master_aspect_ratio_off_plan: plan ${target.aspect_ratio}, master ${actualRatio} (${media.video.width}x${media.video.height})`);
    }
    planChecks.frame_rate = { plan: target.frame_rate ?? null, master: media.video.frame_rate };
    if (target.frame_rate && Math.abs(target.frame_rate - media.video.frame_rate) > 0.01) {
      issues.push(`master_frame_rate_off_plan: plan ${target.frame_rate} fps, master ${media.video.frame_rate} fps`);
    }
    if (Number.isFinite(target.duration_seconds_total)) {
      const tolerance = Number.isFinite(target.duration_tolerance_seconds) ? target.duration_tolerance_seconds : 1;
      planChecks.duration_seconds = { plan: target.duration_seconds_total, tolerance, master: media.duration_seconds };
      if (Math.abs(media.duration_seconds - target.duration_seconds_total) > tolerance) {
        issues.push(
          `master_duration_off_plan: plan ${target.duration_seconds_total}s ±${tolerance}s, master ${media.duration_seconds}s`,
        );
      }
    }
  }
  if (cutList?.total_frames && Math.abs(frames - cutList.total_frames) > 1) {
    issues.push(`frame count is ${frames}, timeline snapshot declares ${cutList.total_frames}`);
  }
  if (defects.black.length) issues.push(`black stretches: ${defects.black.length}`);
  if (defects.freeze.length) {
    // A still or a title card freezes by design; only a human can tell it from a stall.
    warnings.push(`frozen stretches at ${defects.freeze.map((entry) => entry.start).join(", ")}s: confirm each is a deliberate still`);
  }

  let loudness = null;
  if (media.audio) {
    loudness = await tools.measureLoudness(masterPath);
    const [floor, ceiling] = targetLufs;
    if (loudness.integrated_lufs < floor || loudness.integrated_lufs > ceiling) {
      issues.push(`integrated loudness ${loudness.integrated_lufs} LUFS is outside the declared target ${floor}..${ceiling}`);
    }
    if (loudness.true_peak_dbtp > -1) issues.push(`true peak ${loudness.true_peak_dbtp} dBTP leaves no headroom`);
  } else {
    issues.push("master has no audio stream");
  }

  return {
    duration_seconds: media.duration_seconds,
    frames,
    video: media.video,
    audio: media.audio,
    loudness,
    target_lufs: [...targetLufs],
    plan_checks: plan ? planChecks : null,
    black_stretches: defects.black,
    frozen_stretches: defects.freeze,
    issues,
    warnings,
    status: issues.length === 0 ? "ok" : "review_required",
  };
}

/**
 * Copy an exported master into `<masters_root>/<variant>/` as the next version
 * and write its report. Exactly one of `sourcePath` (a file the editor wrote)
 * or `sourceUrl` (the download URL `track_export` returned, on localhost) is
 * required; the source is never moved or altered.
 */
export async function adoptExternalMaster({
  workspaceRoot = process.cwd(),
  projectRoot,
  variantId,
  sourcePath,
  sourceUrl,
  timelinePath,
  renderer = "openchatcut",
  rendererProjectId,
  renderId,
  note,
  targetLufs,
  tools = DEFAULT_TOOLS,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const root = resolve(workspaceRoot);
  const variant = identifier(variantId, "variant");
  const rendererName = identifier(renderer, "renderer");
  if (Boolean(sourcePath) === Boolean(sourceUrl)) {
    throw new TypeError("Provide exactly one of --file or --url");
  }
  const projectDirectory = resolve(root, requiredString(projectRoot, "project"));
  const manifest = await readJson(join(projectDirectory, "project.json"), "project manifest");
  const mastersRoot = manifest?.storage?.masters_root;
  if (typeof mastersRoot !== "string" || !mastersRoot.trim()) {
    throw new Error("project manifest lacks storage.masters_root");
  }
  const mastersRootAbsolute = resolve(root, mastersRoot);
  const masterDirectory = join(mastersRootAbsolute, variant);
  await mkdir(masterDirectory, { recursive: true });
  const lufs = normalizeTargetLufs(targetLufs);

  let staged;
  let origin;
  if (sourceUrl) {
    const url = assertLocalEditorUrl(sourceUrl);
    staged = join(masterDirectory, `.incoming-${process.pid}-${now().getTime()}.mp4`);
    await downloadTo(fetchImpl, url, staged);
    origin = { source_url: url };
  } else {
    staged = resolve(root, sourcePath);
    if (!(await exists(staged))) throw new Error(`source master not found: ${staged}`);
    origin = { source_path: staged };
  }

  try {
    const sourceSha256 = await hashFile(staged);
    const existing = await findAdoptedReport(masterDirectory, sourceSha256);
    if (existing) return { ...existing, reused: true };

    const version = await nextMasterVersion(masterDirectory);
    const stem = `${variant}-master-${version}`;
    const masterPath = join(masterDirectory, `${stem}.mp4`);
    if (sourceUrl) {
      if (await exists(masterPath)) throw new Error(`refusing to overwrite ${masterPath}`);
      await rename(staged, masterPath);
    } else {
      await copyFile(staged, masterPath, constants.COPYFILE_EXCL);
    }

    let timelineRecord = null;
    let cutList = null;
    let cutListPath = null;
    if (timelinePath) {
      const timeline = await readJson(resolve(root, timelinePath), "timeline snapshot");
      timelineRecord = join(masterDirectory, `${stem}.timeline.json`);
      await writeFile(timelineRecord, `${JSON.stringify(timeline, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      cutList = deriveCutList(timeline);
      if (cutList.segments.length) {
        cutListPath = join(masterDirectory, `${stem}.cutlist.json`);
        await writeFile(
          cutListPath,
          `${JSON.stringify(
            {
              derived_from: "openchatcut-timeline",
              base_track: cutList.base_track,
              output: { frame_rate: cutList.fps },
              segments: cutList.segments,
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      }
    }

    const plan = await readFrozenPlan(mastersRootAbsolute);
    const verification = await verifyAdoptedMaster(masterPath, { tools, plan, cutList, targetLufs: lufs });
    for (const warning of cutList?.warnings ?? []) verification.warnings.push(warning);

    const report = {
      schema: ADOPTED_MASTER_SCHEMA,
      variant_id: variant,
      project_id: manifest.project_id ?? null,
      master_path: masterPath,
      master_sha256: sourceSha256,
      version,
      reused: false,
      origin: {
        renderer: rendererName,
        renderer_project_id: optionalString(rendererProjectId, "renderer_project_id") ?? null,
        render_id: optionalString(renderId, "render_id") ?? null,
        ...origin,
        source_sha256: sourceSha256,
        note: optionalString(note, "note") ?? null,
        adopted_at: now().toISOString(),
      },
      timeline_path: timelineRecord,
      cut_list_path: cutListPath,
      cut_list: cutList,
      // Take reviews bind to assembler segments by source hash; an editor timeline
      // references its own media pool, so the binding has to be confirmed by hand.
      review_binding: "unbound",
      plan_checked: Boolean(plan),
      verification,
    };
    await writeFile(join(masterDirectory, `${stem}.report.json`), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return report;
  } finally {
    if (sourceUrl) await unlink(staged).catch(() => {});
  }
}
