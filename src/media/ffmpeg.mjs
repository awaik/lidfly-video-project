import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Thin wrappers around the local ffmpeg toolchain. No editing decisions live
 * here — assembly owns those. Keeping the process boundary in one place is what
 * lets the assembly workflow be tested with a stub runner.
 */
export async function runFfmpeg(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", ...args],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  return stderr;
}

async function runFfprobe(args) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Decoded stream facts: dimensions, frame rate, exact frame count, duration, audio layout. */
export async function probeMedia(path) {
  const raw = await runFfprobe([
    "-show_entries",
    "format=duration",
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,pix_fmt",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(raw);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video") ?? null;
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio") ?? null;
  const [numerator, denominator] = String(video?.r_frame_rate ?? "0/1").split("/");
  return {
    duration_seconds: Number(parsed.format?.duration ?? 0),
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          frame_rate: Number(denominator) === 0 ? 0 : Number(numerator) / Number(denominator),
          pix_fmt: video.pix_fmt,
        }
      : null,
    audio: audio
      ? { codec: audio.codec_name, sample_rate: Number(audio.sample_rate), channels: audio.channels }
      : null,
  };
}

/** Exact decoded frame count — the only reliable way to verify timeline length. */
export async function countFrames(path) {
  const raw = await runFfprobe([
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    path,
  ]);
  return Number(String(raw).trim());
}

/**
 * Integrated loudness and true peak.
 *
 * "Not clipping" alone says nothing about whether a mix is audible, so callers
 * are expected to compare integrated LUFS against a floor, not just the peak.
 */
export async function measureLoudness(path) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-i", path, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const match = /\{[\s\S]*"target_offset"[\s\S]*?\}/.exec(stderr);
  if (!match) throw new Error(`Could not read loudness measurements from ${path}`);
  const measured = JSON.parse(match[0]);
  return {
    integrated_lufs: Number(measured.input_i),
    true_peak_dbtp: Number(measured.input_tp),
    lra: Number(measured.input_lra),
    threshold: Number(measured.input_thresh),
  };
}

/** Mean and peak level over a time window, for per-phase audibility checks. */
export async function measureWindow(path, { start, duration }) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-ss", String(start), "-t", String(duration), "-i", path, "-af", "volumedetect", "-f", "null", "-"],
    { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return {
    start_seconds: start,
    duration_seconds: duration,
    mean_db: mean ? Number(mean[1]) : null,
    max_db: peak ? Number(peak[1]) : null,
  };
}

/** Black and frozen stretches — the classic silent assembly defects. */
export async function detectBlackAndFreeze(path) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      path,
      "-vf",
      "blackdetect=d=0.1:pic_th=0.98,freezedetect=n=0.001:d=0.5",
      "-f",
      "null",
      "-",
    ],
    { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const black = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((match) => ({
    start: Number(match[1]),
    end: Number(match[2]),
  }));
  const freeze = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((match) => ({
    start: Number(match[1]),
  }));
  return { black, freeze };
}

/**
 * RMS envelope of a track, one value per window, in dBFS.
 *
 * Runs ffmpeg directly rather than through runFfmpeg because ametadata prints to
 * stdout, while runFfmpeg returns stderr. `-inf` windows come back as
 * -Infinity so callers can tell silence from a very quiet sound.
 */
export async function measureBandEnvelope(
  path,
  { windowSeconds = 0.05, sampleRate = 16_000, highpassHz = null, lowpassHz = null } = {},
) {
  const samples = Math.max(1, Math.round(sampleRate * windowSeconds));
  const band = [
    highpassHz === null ? null : `highpass=f=${highpassHz}`,
    lowpassHz === null ? null : `lowpass=f=${lowpassHz}`,
  ]
    .filter(Boolean)
    .join(",");
  const filter = [
    "aformat=sample_fmts=fltp:channel_layouts=mono",
    `aresample=${sampleRate}`,
    band,
    `asetnsamples=n=${samples}:p=0`,
    "astats=metadata=1:reset=1",
    "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
  ]
    .filter(Boolean)
    .join(",");

  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-v", "error", "-i", path, "-vn", "-af", filter, "-f", "null", "-"],
    { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
  );
  const windows = [];
  for (const line of stdout.split("\n")) {
    const match = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?|-inf)/.exec(line);
    if (!match) continue;
    windows.push(match[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]));
  }
  return { window_seconds: windowSeconds, sample_rate: sampleRate, windows };
}

/**
 * Save one frame of a video as PNG.
 *
 * For the last frame the idiom is `-sseof -1` with `-update 1` and no
 * `-frames:v 1`: update overwrites the same file with every decoded frame, so
 * what remains is genuinely the last one. Asking for a single frame after the
 * seek would hand back the first frame of the tail instead.
 */
export async function extractFrame(videoPath, targetPath, { position = "last" } = {}) {
  const args =
    position === "first"
      ? ["-i", videoPath, "-frames:v", "1", targetPath]
      : ["-sseof", "-1", "-i", videoPath, "-update", "1", targetPath];
  await runFfmpeg(args);
  return targetPath;
}
