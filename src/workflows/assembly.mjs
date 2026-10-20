import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashFile, hashValue } from "../core/hashing.mjs";
import { exists } from "../core/workspace-files.mjs";
import { normalizeEditManifest } from "../domain/edit-manifest.mjs";
import {
  aspectRatioMatches,
  dimensionsMatchRatio,
  formatAspectRatio,
} from "../domain/aspect-ratio.mjs";
import { projectPathsFromMastersRoot } from "./budget.mjs";
import { normalizeReviewRecord } from "../domain/review-record.mjs";
import {
  countFrames,
  detectBlackAndFreeze,
  measureLoudness,
  measureWindow,
  probeMedia,
  runFfmpeg,
} from "../media/ffmpeg.mjs";

const DEFAULT_TOOLS = { runFfmpeg, probeMedia, countFrames, measureLoudness, measureWindow, detectBlackAndFreeze };

/**
 * Keep intermediate audio lossless. Encoding each cut to AAC adds encoder
 * padding at every join; only the final delivery encodes AAC, once.
 * Every segment carries an audio track, including silent cuts.
 */
function encoderArgs({ frame_rate: frameRate, audio_sample_rate: sampleRate }) {
  return [
    "-r", String(frameRate),
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-c:a", "pcm_s24le",
    "-ar", String(sampleRate),
    "-ac", "2",
  ];
}

function silenceInput(seconds, sampleRate) {
  return ["-f", "lavfi", "-t", String(seconds), "-i", `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`];
}

function overlayChain(overlays, startLabel, firstInputIndex) {
  const filters = [];
  let last = startLabel;
  overlays.forEach((overlay, position) => {
    const inputIndex = firstInputIndex + position;
    let source = `[${inputIndex}:v]`;
    if (overlay.scale) {
      filters.push(`[${inputIndex}:v]scale=${overlay.scale}[ov${position}]`);
      source = `[ov${position}]`;
    }
    const enable = [
      overlay.from_seconds > 0 ? `gte(t,${overlay.from_seconds})` : null,
      overlay.to_seconds === undefined ? null : `lte(t,${overlay.to_seconds})`,
    ].filter(Boolean);
    const next = `vo${position}`;
    filters.push(
      `[${last}]${source}overlay=${overlay.x}:${overlay.y}` +
        (enable.length ? `:enable='${enable.join("*")}'` : "") +
        `[${next}]`,
    );
    last = next;
  });
  return { filters, label: last };
}

/**
 * Decompose a tempo change into steps ffmpeg's atempo accepts.
 *
 * The filter documents 0.5..100, but chaining inside 0.5..2.0 is what every
 * build agrees on and is indistinguishable by ear.
 */
export function atempoChain(factor) {
  const steps = [];
  let remaining = factor;
  while (remaining < 0.5 - 1e-9) {
    steps.push(0.5);
    remaining /= 0.5;
  }
  while (remaining > 2 + 1e-9) {
    steps.push(2);
    remaining /= 2;
  }
  steps.push(Math.round(remaining * 1e6) / 1e6);
  return steps.map((step) => `atempo=${step}`).join(",");
}

function retimeFilter(interpolation, frameRate) {
  if (interpolation === "blend") return `minterpolate=fps=${frameRate}:mi_mode=blend`;
  if (interpolation === "motion") {
    return `minterpolate=fps=${frameRate}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
  }
  return `fps=${frameRate}`;
}

/**
 * Bring a source to exactly width x height.
 *
 * `stretch` is what this file did unconditionally before fit existed, and it
 * is still the right answer when an operator wants it — but it is now something
 * a manifest says out loud rather than something geometry does behind its back.
 * Every mode lands on the exact output size: concat splices with `-c copy`, so
 * a segment even one pixel off desynchronises everything after it.
 */
function fitChain(width, height, fit) {
  if (fit === "pad") {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    );
  }
  if (fit === "cover") {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
      `crop=${width}:${height},setsar=1`
    );
  }
  return `scale=${width}:${height},setsar=1`;
}

function motionFilter(segment, output, fit) {
  const { width, height, frame_rate: fps } = output;
  const seconds = segment.duration_seconds;
  if (segment.motion.type === "scroll") {
    // Ease-out so the scroll settles instead of stopping dead.
    // No fit here: a scroll deliberately feeds an over-tall source and crops a
    // moving window out of it, so "make it the output shape" is the one thing
    // this segment must not do.
    return `crop=${width}:${height}:0:'${segment.motion.to_y}*(1-pow(1-min(t/${seconds}\\,1)\\,2))',fps=${fps}`;
  }
  if (segment.motion.type === "zoom_in") {
    const zoom = `(1+${segment.motion.amount}*min(t/${seconds}\\,1))`;
    // Fit at the doubled size so the crop maths below is unchanged.
    return (
      `fps=${fps},${fitChain(width * 2, height * 2, fit)},` +
      `crop=w='${width * 2}/${zoom}':h='${height * 2}/${zoom}':x='(in_w-out_w)/2':y='(in_h-out_h)/2',` +
      `scale=${width}:${height},setsar=1`
    );
  }
  return `fps=${fps},${fitChain(width, height, fit)}`;
}

async function buildSegment(segment, { manifest, tools, resolvePath, workDirectory, version }) {
  const output = manifest.output;
  const fit = segment.fit ?? output.fit ?? "stretch";
  const target = join(workDirectory, `${segment.id}-${version}.mov`);
  const seconds = segment.duration_seconds;
  // Round timeline boundaries, not each duration independently: at rates such
  // as 24 fps / 44.1 kHz a frame contains a fractional number of samples.
  const samples = Math.round((segment.start_seconds + seconds) * output.audio_sample_rate) -
    Math.round(segment.start_seconds * output.audio_sample_rate);
  const exactAudio = `aresample=${output.audio_sample_rate},apad,atrim=end_sample=${samples},asetpts=N/SR/TB[aout]`;
  const inputs = [];
  const filters = [];

  if (segment.kind === "clip") {
    inputs.push("-i", resolvePath(segment.source));
    const { factor, interpolation } = segment.speed;
    // A clip may carry a post move too. The schema always accepted `motion`
    // here; only stills honoured it, so a declared push-in validated and then
    // did nothing — the master looked identical and nothing said why.
    const clipMotion =
      segment.motion.type === "none"
        ? `fps=${output.frame_rate},${fitChain(output.width, output.height, fit)}`
        : motionFilter(segment, output, fit);
    // Trim by frame count, not by seconds, so the cut length is exact.
    if (factor === 1) {
      filters.push(
        `[0:v]trim=start=${segment.in_seconds},setpts=PTS-STARTPTS,${clipMotion},` +
          `trim=end_frame=${segment.total_frames},setpts=PTS-STARTPTS[vbase]`,
      );
    } else {
      // scale before minterpolate: motion estimation at delivery size is far
      // cheaper and visually equivalent.
      filters.push(
        `[0:v]trim=start=${segment.in_seconds},setpts=PTS-STARTPTS,` +
          `setpts=${(1 / factor).toFixed(6)}*PTS,${clipMotion},` +
          `${retimeFilter(interpolation, output.frame_rate)},` +
          `trim=end_frame=${segment.total_frames},setpts=PTS-STARTPTS[vbase]`,
      );
    }
  } else if (segment.kind === "still") {
    inputs.push("-loop", "1", "-t", String(seconds), "-i", resolvePath(segment.source));
    filters.push(
      `[0:v]${motionFilter(segment, output, fit)},trim=end_frame=${segment.total_frames},setpts=PTS-STARTPTS[vbase]`,
    );
  } else {
    const labels = [];
    segment.sources.forEach((source, position) => {
      const frames = segment.frames[position];
      inputs.push("-loop", "1", "-t", String(frames / output.frame_rate), "-i", resolvePath(source));
      filters.push(
        `[${position}:v]fps=${output.frame_rate},${fitChain(output.width, output.height, fit)},` +
          `trim=end_frame=${frames},setpts=PTS-STARTPTS[s${position}]`,
      );
      labels.push(`[s${position}]`);
    });
    filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[vbase]`);
  }

  const overlayInputStart = segment.kind === "still_sequence" ? segment.sources.length : 1;
  for (const overlay of segment.overlays) inputs.push("-i", resolvePath(overlay.asset));
  const chain = overlayChain(segment.overlays, "vbase", overlayInputStart);
  filters.push(...chain.filters);

  let audioMap;
  if (segment.kind === "clip" && segment.audio === "source") {
    const { factor } = segment.speed;
    const sourceSeconds = Math.round(seconds * factor * 1e6) / 1e6;
    if (factor === 1) {
      filters.push(
        `[0:a]atrim=start=${segment.in_seconds}:duration=${seconds},asetpts=PTS-STARTPTS,` +
          exactAudio,
      );
    } else {
      // atempo lands within milliseconds of the target; apad+atrim make the
      // stream exactly as long as the picture, because concat accumulates drift.
      filters.push(
        `[0:a]atrim=start=${segment.in_seconds}:duration=${sourceSeconds},asetpts=PTS-STARTPTS,` +
          `${atempoChain(factor)},${exactAudio}`,
      );
    }
    audioMap = "[aout]";
  } else {
    inputs.push(...silenceInput(seconds, output.audio_sample_rate));
    filters.push(`[${overlayInputStart + segment.overlays.length}:a]${exactAudio}`);
    audioMap = "[aout]";
  }

  await tools.runFfmpeg([
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[${chain.label}]`,
    "-map",
    audioMap,
    ...encoderArgs(output),
    target,
  ]);
  return target;
}

/**
 * Music level over time: full in graphics blocks, ducked under speech.
 *
 * Written as an explicit curve rather than a sidechain compressor because the
 * speech windows are known from the cut, which keeps the mix reproducible.
 */
export function duckingExpression(speechWindows, { level, ramp_seconds: ramp }) {
  if (speechWindows.length === 0) return null;
  const rampUp = (from) => `min(1,max(0,(t-${from})/${ramp}))`;
  return speechWindows.reduce((expression, [start, end]) => {
    const inSpeech = `(${rampUp(Math.max(0, start - ramp))}*(1-${rampUp(end)}))`;
    return `${expression}*(1-${(1 - level).toFixed(4)}*${inSpeech})`;
  }, "1");
}

function mixFilter(manifest) {
  const { audio, speech_windows: speechWindows, output } = manifest;
  const hasSpeech = speechWindows.length > 0;
  const [floor, ceiling] = audio.target_lufs;
  const midpoint = Math.round(((floor + ceiling) / 2) * 10) / 10;
  const parts = [];

  if (audio.music) {
    const level = hasSpeech ? duckingExpression(speechWindows, audio.ducking) : null;
    const fade = audio.music.fade_out_from_seconds === undefined
      ? ""
      : `,afade=t=out:st=${audio.music.fade_out_from_seconds}:d=${audio.music.fade_out_seconds}`;
    parts.push(
      `[1:a]${level ? `volume=eval=frame:volume='${level}',` : ""}` +
        // Without speech the bed carries the whole mix, so it is normalized to
        // the delivery target instead of being ducked under anything.
        (hasSpeech ? `volume=${audio.music.gain}` : `loudnorm=I=${midpoint}:TP=-2:LRA=9,volume=${audio.music.gain}`) +
        `${fade}[music]`,
    );
  }

  const hasNativeSpeech = manifest.segments.some((segment) => segment.kind === "clip" && segment.audio === "source");
  const cues = audio.voiceover?.cues ?? [];
  if (cues.length) {
    // Each cue lands at its declared time; the bus is normalized on its own,
    // exactly like native speech, so the music ducks under a known level.
    const firstCueInput = audio.music ? 2 : 1;
    cues.forEach((cue, index) => {
      const delay = Math.round(cue.at_seconds * 1000);
      parts.push(
        `[${firstCueInput + index}:a]aresample=${output.audio_sample_rate},aformat=channel_layouts=stereo,` +
          `adelay=${delay}|${delay},apad[cue${index}]`,
      );
    });
    const cueLabels = cues.map((_, index) => `[cue${index}]`).join("");
    parts.push(
      `${cueLabels}${cues.length > 1 ? `amix=inputs=${cues.length}:duration=longest:dropout_transition=0:normalize=0,` : ""}` +
        `atrim=0:${manifest.total_seconds},loudnorm=I=${audio.speech.normalize_lufs}:TP=-2:LRA=11,volume=${audio.speech.gain}[voiceover]`,
    );
  }

  const nativeAsEffects = hasNativeSpeech && audio.native?.role === "effects";
  if (nativeAsEffects) {
    // Effects keep the relative level the model gave them: a loudnorm would
    // lift the room tone of a quiet take to dialogue loudness. They duck under
    // the voiceover so a meow never competes with a line.
    const cueWindows = cues.map((cue) => [cue.at_seconds, cue.at_seconds + cue.duration_seconds]);
    const duck = cueWindows.length
      ? duckingExpression(cueWindows, { level: audio.native.duck_level, ramp_seconds: audio.ducking.ramp_seconds })
      : null;
    parts.push(
      `[0:a]aresample=${output.audio_sample_rate},` +
        `${duck ? `volume=eval=frame:volume='${duck}',` : ""}volume=${audio.native.gain}[native]`,
    );
  } else if (hasNativeSpeech) {
    // Native model speech arrives quiet, so it is normalized on its own before
    // music is ducked under it. A loudnorm over the finished mix would undo the
    // ducking by pulling the quiet passages back up.
    parts.push(
      `[0:a]aresample=${output.audio_sample_rate},loudnorm=I=${audio.speech.normalize_lufs}:TP=-2:LRA=11,` +
        `volume=${audio.speech.gain}[speech]`,
    );
  }

  const streams = [
    nativeAsEffects ? "[native]" : hasNativeSpeech ? "[speech]" : null,
    cues.length ? "[voiceover]" : null,
    audio.music ? "[music]" : null,
  ].filter(Boolean);
  if (streams.length === 0) return null;
  // A label is followed by a filter directly; a comma only separates chained
  // filters, so it belongs after amix and nowhere else.
  const mixed =
    streams.length === 1
      ? streams[0]
      : `${streams.join("")}amix=inputs=${streams.length}:duration=first:dropout_transition=0:normalize=0,`;
  // level=disabled: alimiter auto-levels by default and pushes peaks straight
  // back up to the limit, which silently defeats the ceiling.
  parts.push(`${mixed}alimiter=limit=${audio.limit}:level=disabled[aout]`);
  return parts.join(";");
}

/** Next unused `-master-vN` in a variant directory; shared with adopted masters so versions never collide. */
export async function nextMasterVersion(directory) {
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const used = entries
    .map((name) => /-master-v(\d+)\.mp4$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  return `v${(used.length ? Math.max(...used) : 0) + 1}`;
}

/**
 * Identity of the assembler itself.
 *
 * Bump it whenever encoder arguments or the filter graph change: without it a
 * cached fingerprint would return a master built by older code.
 */
const ASSEMBLER_REVISION = 5;

function segmentInputPaths(manifest) {
  const paths = [];
  for (const segment of manifest.segments) {
    if (segment.kind === "still_sequence") paths.push(...segment.sources);
    else paths.push(segment.source);
    for (const overlay of segment.overlays) paths.push(overlay.asset);
  }
  if (manifest.audio?.music) paths.push(manifest.audio.music.source);
  for (const cue of manifest.audio?.voiceover?.cues ?? []) paths.push(cue.source);
  return [...new Set(paths)];
}

/**
 * What this master is made of: the normalized manifest, the assembler revision
 * and the content of every input file. Re-running an unchanged edit then costs
 * nothing instead of re-encoding the whole timeline.
 */
async function fingerprintInputs(manifest, resolvePath) {
  const files = [];
  for (const path of segmentInputPaths(manifest).sort()) {
    const absolute = resolvePath(path);
    if (!(await exists(absolute))) {
      throw new Error(`Edit manifest references a file that does not exist: ${absolute}`);
    }
    files.push({ path, sha256: await hashFile(absolute) });
  }
  const manifestSha256 = hashValue(manifest);
  return {
    algorithm: "sha256",
    assembler_revision: ASSEMBLER_REVISION,
    manifest_sha256: manifestSha256,
    files,
    fingerprint: hashValue({ manifestSha256, assembler_revision: ASSEMBLER_REVISION, files }),
  };
}

/**
 * Refuse a source whose shape nobody decided what to do with.
 *
 * Until this existed every source was scaled to the output size, so a 16:9 take
 * dropped into a 9:16 master came out stretched and nothing said so. Declaring
 * `fit` is cheap; discovering a distorted face after delivery is not.
 *
 * Runs before any encoding, next to the fingerprint that already refuses a
 * missing input, and only inspects segment sources: overlays carry their own
 * author-written `scale`, and a scroll deliberately feeds an over-tall image.
 */
/** A cue whose declared length disagrees with its file would duck the music in the wrong place. */
async function assertVoiceoverCues(manifest, resolvePath, tools) {
  for (const cue of manifest.audio?.voiceover?.cues ?? []) {
    const probed = await tools.probeMedia(resolvePath(cue.source));
    if (Math.abs(probed.duration_seconds - cue.duration_seconds) > 0.05) {
      throw new Error(
        `Voiceover cue ${cue.id} declares ${cue.duration_seconds} s but ${cue.source} is ${probed.duration_seconds} s`,
      );
    }
  }
}

async function assertSourcesFit(manifest, resolvePath, tools) {
  const output = manifest.output;
  const probed = new Map();
  for (const segment of manifest.segments) {
    if (segment.kind === "still" && segment.motion.type === "scroll") continue;
    if ((segment.fit ?? output.fit) !== undefined) continue;
    const sources = segment.kind === "still_sequence" ? segment.sources : [segment.source];
    for (const source of sources) {
      if (!probed.has(source)) probed.set(source, await tools.probeMedia(resolvePath(source)));
      const video = probed.get(source)?.video;
      if (!video?.width || !video?.height) continue;
      if (dimensionsMatchRatio(video.width, video.height, output.width, output.height)) continue;
      throw new Error(
        `Segment ${segment.id} source ${source} is ${video.width}x${video.height} ` +
          `(${formatAspectRatio(video.width, video.height)}) but the master is ${output.width}x${output.height} ` +
          `(${formatAspectRatio(output.width, output.height)}). Declare output.fit or segment fit: ` +
          `"pad" (letterbox, nothing lost), "cover" (fill, edges cropped) or "stretch" (the old behaviour, distorts).`,
      );
    }
  }
}

/**
 * A previously built master whose inputs are byte-for-byte the same.
 * The master file itself is re-hashed: a report without its master is stale.
 */
async function findReusableReport(masterDirectory, fingerprint) {
  let entries = [];
  try {
    entries = await readdir(masterDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
  for (const name of entries.filter((entry) => entry.endsWith(".report.json")).sort().reverse()) {
    let report;
    try {
      report = JSON.parse(await readFile(join(masterDirectory, name), "utf8"));
    } catch {
      continue;
    }
    if (report?.inputs_fingerprint?.fingerprint !== fingerprint) continue;
    if (!(await exists(report.master_path))) continue;
    if ((await sha256(report.master_path)) !== report.master_sha256) continue;
    return report;
  }
  return null;
}

async function sha256(path) {
  return hashFile(path);
}

/**
 * Check that every generated clip in the timeline points at a review that
 * actually accepted the take, and that the cut stays inside what was reviewed.
 *
 * Findings are warnings by default because two existing projects predate this
 * rule; `requireReview` promotes them for anything new.
 */
async function resolveSegmentReviews(manifest, resolvePath, fingerprint, { requireReview }) {
  const shaByPath = new Map(fingerprint.files.map((file) => [file.path, file.sha256]));
  const level = (soft) => (requireReview || !soft ? "blocker" : "warning");
  const reviews = [];
  const issues = [];

  for (const segment of manifest.segments) {
    if (segment.kind !== "clip") continue;
    const entry = { segment_id: segment.id, source: segment.source };

    if (!segment.review) {
      entry.status = "missing";
      issues.push({ level: level(true), code: "review_missing", segment_id: segment.id });
      reviews.push(entry);
      continue;
    }
    if (segment.review.kind === "note") {
      entry.status = "note";
      entry.note = segment.review.value;
      issues.push({ level: level(true), code: "review_not_machine_readable", segment_id: segment.id });
      reviews.push(entry);
      continue;
    }

    entry.review_path = segment.review.value;
    let record;
    try {
      record = normalizeReviewRecord(
        JSON.parse(await readFile(resolvePath(segment.review.value), "utf8")),
        `segment ${segment.id} review`,
      );
    } catch (error) {
      entry.status = "unreadable";
      entry.error = String(error?.message ?? error);
      // An unreadable review is worse than none: the manifest claims one exists.
      issues.push({ level: "blocker", code: "review_unreadable", segment_id: segment.id });
      reviews.push(entry);
      continue;
    }

    entry.status = record.accepts ? "accepted" : "rejected";
    entry.decision = record.decision;
    if (!record.accepts) {
      issues.push({ level: "blocker", code: "review_rejected", segment_id: segment.id });
    }
    const expected = shaByPath.get(segment.source);
    if (record.source_sha256 && expected && record.source_sha256 !== expected) {
      entry.source_matches_review = false;
      issues.push({ level: level(true), code: "review_source_mismatch", segment_id: segment.id });
    } else if (record.source_sha256) {
      entry.source_matches_review = true;
    }
    if (record.usable_range_seconds) {
      const consumed = segment.duration_seconds * segment.speed.factor;
      const cut = [segment.in_seconds, Math.round((segment.in_seconds + consumed) * 1e3) / 1e3];
      entry.cut_seconds = cut;
      entry.usable_range_seconds = record.usable_range_seconds;
      if (cut[0] < record.usable_range_seconds[0] || cut[1] > record.usable_range_seconds[1] + 1e-3) {
        issues.push({ level: level(true), code: "review_range_exceeded", segment_id: segment.id });
      }
    }
    reviews.push(entry);
  }

  return { reviews, issues };
}

/**
 * Overlays declare where the subject was when their position was chosen.
 * Assembly does not re-check the picture, but it does insist the claim exists
 * and that a declared collision never reaches the master.
 */
function overlayClearanceIssues(manifest, { requireReview }) {
  const level = requireReview ? "blocker" : "warning";
  const clearance = [];
  const issues = [];
  for (const segment of manifest.segments) {
    for (const [index, overlay] of segment.overlays.entries()) {
      const window = [overlay.from_seconds, overlay.to_seconds ?? segment.duration_seconds];
      const entry = {
        segment_id: segment.id,
        overlay_index: index,
        asset: overlay.asset,
        window_seconds: window,
        checked_at_seconds: overlay.subject_checked_at_seconds ?? null,
        subject_clear: overlay.subject_clear ?? null,
      };
      clearance.push(entry);

      if (overlay.subject_clear === false) {
        issues.push({ level: "blocker", code: "overlay_subject_collision", segment_id: segment.id });
      }
      if (!overlay.subject_checked_at_seconds) {
        issues.push({ level, code: "overlay_clearance_undeclared", segment_id: segment.id });
        continue;
      }
      const span = window[1] - window[0];
      const moving = segment.motion.type !== "none";
      if ((span > 1.5 || moving) && overlay.subject_checked_at_seconds.length < 3) {
        issues.push({ level, code: "overlay_clearance_sparse", segment_id: segment.id });
      }
    }
  }
  return { clearance, issues };
}

/**
 * Does the master agree with the plan the shots were generated from?
 *
 * The shot plan is the reviewed, frozen record of what this video is supposed
 * to be, and until now nothing compared it to the edit: a 16:9 plan cut into a
 * 720x1280 master was two documents disagreeing with nobody in the room.
 * Silent for an ad-hoc masters root, which no project governs.
 */
async function shotPlanAgreementIssues(manifest, resolvePath, { requireReview }) {
  const level = requireReview ? "blocker" : "warning";
  const paths = projectPathsFromMastersRoot(resolvePath(manifest.output.masters_root));
  if (!paths) return { issues: [] };
  let plan;
  try {
    plan = JSON.parse(await readFile(paths.shotPlanPath, "utf8"));
  } catch {
    // No plan, or one we cannot read: assembly is not the place to adjudicate that.
    return { issues: [] };
  }
  if (plan?.status !== "frozen" || !plan?.target) return { issues: [] };

  // These describe the master as a whole, not a segment, so they carry their own
  // finished line rather than borrowing the "<code> on segment <id>" shape.
  const issues = [];
  const target = plan.target.aspect_ratio;
  const actual = formatAspectRatio(manifest.output.width, manifest.output.height);
  // "adaptive" declares no shape of its own, so there is nothing to disagree with.
  if (target && target !== "adaptive" && !aspectRatioMatches(manifest.output.width, manifest.output.height, target)) {
    issues.push({
      level,
      line: `master_aspect_ratio_off_plan: plan ${target}, master ${actual} (${manifest.output.width}x${manifest.output.height})`,
    });
  }
  if (plan.target.frame_rate && plan.target.frame_rate !== manifest.output.frame_rate) {
    issues.push({
      level,
      line: `master_frame_rate_off_plan: plan ${plan.target.frame_rate} fps, master ${manifest.output.frame_rate} fps`,
    });
  }
  return { issues };
}

/**
 * Assemble a master from a declarative edit manifest.
 *
 * Nothing is overwritten: each run writes the next -master-vN.mp4 and keeps its
 * intermediates, in line with the project's retention policy.
 */
export async function assembleMaster(
  manifestPath,
  { workspaceRoot = process.cwd(), tools = DEFAULT_TOOLS, force = false, requireReview = false } = {},
) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = normalizeEditManifest(JSON.parse(await readFile(absoluteManifestPath, "utf8")));
  const root = resolve(workspaceRoot);
  const resolvePath = (value) => (value.startsWith("/") ? value : join(root, value));

  const masterDirectory = join(root, manifest.output.masters_root, manifest.variant_id);
  const inputsFingerprint = await fingerprintInputs(manifest, resolvePath);
  await assertSourcesFit(manifest, resolvePath, tools);
  await assertVoiceoverCues(manifest, resolvePath, tools);
  if (!force) {
    const reusable = await findReusableReport(masterDirectory, inputsFingerprint.fingerprint);
    if (reusable) return { ...reusable, reused: true };
  }
  const workDirectory = join(masterDirectory, "_intermediates");
  await mkdir(workDirectory, { recursive: true });
  const version = await nextMasterVersion(masterDirectory);

  const segments = [];
  for (const segment of manifest.segments) {
    segments.push(
      await buildSegment(segment, { manifest, tools, resolvePath, workDirectory, version }),
    );
  }

  const listPath = join(workDirectory, `concat-${version}.txt`);
  await writeFile(listPath, `${segments.map((path, index) =>
    `file '${path}'\nduration ${manifest.segments[index].duration_seconds}`,
  ).join("\n")}\n`, "utf8");
  const stitched = join(workDirectory, `visual-${version}.mov`);
  await tools.runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", stitched]);

  const masterPath = join(masterDirectory, `${manifest.variant_id}-master-${version}.mp4`);
  const filter = manifest.audio ? mixFilter(manifest) : null;
  if (filter) {
    await tools.runFfmpeg([
      "-i", stitched,
      ...(manifest.audio.music ? ["-i", resolvePath(manifest.audio.music.source)] : []),
      ...(manifest.audio.voiceover?.cues ?? []).flatMap((cue) => ["-i", resolvePath(cue.source)]),
      "-filter_complex", filter,
      "-map", "0:v",
      "-map", "[aout]",
      "-t", String(manifest.total_seconds),
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", String(manifest.output.audio_sample_rate),
      "-movflags", "+faststart",
      masterPath,
    ]);
  } else {
    await tools.runFfmpeg([
      "-i", stitched, "-t", String(manifest.total_seconds),
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-ar", String(manifest.output.audio_sample_rate),
      "-movflags", "+faststart", masterPath,
    ]);
  }

  const verification = await verifyMaster(masterPath, manifest, tools);
  const reviewResult = await resolveSegmentReviews(manifest, resolvePath, inputsFingerprint, {
    requireReview,
  });
  const overlayResult = overlayClearanceIssues(manifest, { requireReview });
  const planResult = await shotPlanAgreementIssues(manifest, resolvePath, { requireReview });
  for (const issue of [...reviewResult.issues, ...overlayResult.issues]) {
    const line = `${issue.code} on segment ${issue.segment_id}`;
    if (issue.level === "blocker") verification.issues.push(line);
    else verification.warnings.push(line);
  }
  for (const issue of planResult.issues) {
    if (issue.level === "blocker") verification.issues.push(issue.line);
    else verification.warnings.push(issue.line);
  }
  if (verification.issues.length) verification.status = "review_required";

  const report = {
    variant_id: manifest.variant_id,
    ...(manifest.project_id ? { project_id: manifest.project_id } : {}),
    master_path: masterPath,
    master_sha256: await sha256(masterPath),
    version,
    manifest_path: absoluteManifestPath,
    inputs_fingerprint: inputsFingerprint,
    reused: false,
    segments: manifest.segments.map((segment, index) => ({
      id: segment.id,
      kind: segment.kind,
      start_seconds: segment.start_seconds,
      frames: segment.total_frames,
      ...(segment.kind === "clip" && segment.speed.factor !== 1
        ? {
            speed: segment.speed.factor,
            interpolation: segment.speed.interpolation,
            source_seconds: Math.round(segment.duration_seconds * segment.speed.factor * 1e6) / 1e6,
          }
        : {}),
      ...(segment.review === undefined ? {} : { review: segment.review }),
      path: segments[index],
    })),
    reviews: reviewResult.reviews,
    overlay_clearance: overlayResult.clearance,
    audio: manifest.audio
      ? {
          music_rights: manifest.audio.music?.rights ?? null,
          voiceover: manifest.audio.voiceover
            ? {
                rights: manifest.audio.voiceover.rights,
                provenance: manifest.audio.voiceover.provenance ?? null,
                cues: manifest.audio.voiceover.cues,
              }
            : null,
          native: manifest.audio.native ?? null,
          speech_windows: manifest.speech_windows,
          ducking: manifest.speech_windows.length ? manifest.audio.ducking : null,
        }
      : null,
    verification,
  };
  await writeFile(
    join(masterDirectory, `${manifest.variant_id}-master-${version}.report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

/**
 * Decode the finished master and record measured numbers, not pass/fail labels:
 * duration, frame count, loudness against the declared target, per-phase levels
 * and black/frozen stretches.
 */
export async function verifyMaster(masterPath, manifest, tools = DEFAULT_TOOLS) {
  const [media, frames, defects] = await Promise.all([
    tools.probeMedia(masterPath),
    tools.countFrames(masterPath),
    tools.detectBlackAndFreeze(masterPath),
  ]);

  const issues = [];
  if (frames !== manifest.total_frames) {
    issues.push(`frame count is ${frames}, manifest declares ${manifest.total_frames}`);
  }
  if (media.video?.width !== manifest.output.width || media.video?.height !== manifest.output.height) {
    issues.push(`dimensions are ${media.video?.width}x${media.video?.height}, expected ${manifest.output.width}x${manifest.output.height}`);
  }
  if (defects.black.length) issues.push(`black stretches: ${defects.black.length}`);

  // A graphics block is a still by construction, so freezedetect always fires on
  // it. Only a frozen stretch inside generated footage is a real defect.
  const segmentAt = (seconds) =>
    manifest.segments.find(
      (segment) =>
        seconds >= segment.start_seconds &&
        seconds < segment.start_seconds + segment.duration_seconds,
    ) ?? null;
  const unexpectedFreeze = defects.freeze.filter(
    (entry) => segmentAt(entry.start)?.kind === "clip",
  );
  if (unexpectedFreeze.length) {
    issues.push(
      `frozen stretches inside generated footage: ${unexpectedFreeze.map((entry) => entry.start).join(", ")}`,
    );
  }

  let loudness = null;
  let phases = null;
  if (manifest.audio) {
    loudness = await tools.measureLoudness(masterPath);
    const [floor, ceiling] = manifest.audio.target_lufs;
    if (loudness.integrated_lufs < floor || loudness.integrated_lufs > ceiling) {
      issues.push(
        `integrated loudness ${loudness.integrated_lufs} LUFS is outside the declared target ${floor}..${ceiling}`,
      );
    }
    if (loudness.true_peak_dbtp > -1) {
      issues.push(`true peak ${loudness.true_peak_dbtp} dBTP leaves no headroom`);
    }
    // Per-segment levels catch a bed that is technically present but inaudible.
    phases = [];
    for (const segment of manifest.segments) {
      phases.push({
        id: segment.id,
        ...(await tools.measureWindow(masterPath, {
          start: segment.start_seconds,
          duration: segment.duration_seconds,
        })),
      });
    }
  }

  return {
    duration_seconds: media.duration_seconds,
    frames,
    video: media.video,
    audio: media.audio,
    loudness,
    phase_levels: phases,
    black_stretches: defects.black,
    frozen_stretches: defects.freeze,
    // Kept separate so a still-by-design block is never confused with a stall.
    frozen_in_footage: unexpectedFreeze,
    issues,
    // Soft findings live beside the hard ones so a report never has to choose
    // between "silently fine" and "failed".
    warnings: [],
    status: issues.length === 0 ? "ok" : "review_required",
  };
}
