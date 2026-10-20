import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkOpenChatCut } from "./openchatcut.mjs";

const execFileAsync = promisify(execFile);

/**
 * Fonts the graphics scripts can realistically use, in preference order.
 * Helvetica is listed because it is the obvious default on macOS — and because
 * it silently drops the ruble sign, which is exactly the failure this checks for.
 */
const FONT_CANDIDATES = Object.freeze(["PT Sans", "Helvetica", "Arial Unicode", "DejaVu Sans"]);

const SEVERITY_ORDER = Object.freeze({ ok: 0, warning: 1, error: 2 });

function worst(...severities) {
  return severities.reduce((a, b) => (SEVERITY_ORDER[b] > SEVERITY_ORDER[a] ? b : a), "ok");
}

async function defaultRunCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function firstLine(text) {
  return String(text).split("\n", 1)[0].trim();
}

async function checkBinary(runCommand, file, args = ["-version"]) {
  try {
    return { available: true, version: firstLine(await runCommand(file, args)) };
  } catch (error) {
    return { available: false, error: error?.code === "ENOENT" ? "not found on PATH" : String(error?.message ?? error) };
  }
}

/**
 * Render an SVG and report whether anything was actually drawn.
 * `%[fx:minima]` is 1 on a pure-white canvas, so a value near 1 means the ink
 * never landed — which is exactly what a dropped stroke or a missing glyph looks like.
 */
async function renderedInk(runCommand, workDirectory, name, svg) {
  const svgPath = join(workDirectory, `${name}.svg`);
  const pngPath = join(workDirectory, `${name}.png`);
  await writeFile(svgPath, svg, "utf8");
  await runCommand("magick", [svgPath, pngPath]);
  const minima = Number(firstLine(await runCommand("magick", [pngPath, "-format", "%[fx:minima]", "info:"])));
  if (!Number.isFinite(minima)) throw new Error(`Could not measure rendered output for ${name}`);
  return minima < 0.5;
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textSvg(font, text) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="80">` +
    `<rect width="260" height="80" fill="#fff"/>` +
    `<text x="12" y="56" font-family="${escapeXml(font)}" font-size="46" fill="#000">${escapeXml(text)}</text>` +
    `</svg>`
  );
}

const STROKE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">` +
  `<rect width="60" height="60" fill="#fff"/>` +
  `<rect x="8" y="8" width="44" height="44" fill="none" stroke="#000" stroke-width="6"/>` +
  `</svg>`;

/**
 * Check the local rendering toolchain the assembly step depends on.
 *
 * Every failure mode here was observed in production and was silent: ImageMagick
 * without librsvg drops SVG stroke, and Helvetica drops the ruble sign. Both
 * produced wrong frames that only a human eye caught.
 */
export async function checkTooling({ runCommand = defaultRunCommand } = {}) {
  const report = {};
  const [ffmpeg, ffprobe, magick] = await Promise.all([
    checkBinary(runCommand, "ffmpeg"),
    checkBinary(runCommand, "ffprobe"),
    checkBinary(runCommand, "magick", ["--version"]),
  ]);
  report.ffmpeg = ffmpeg;
  report.ffprobe = ffprobe;
  report.imagemagick = magick;

  let severity = worst(
    ffmpeg.available ? "ok" : "error",
    ffprobe.available ? "ok" : "error",
    magick.available ? "ok" : "error",
  );

  if (!magick.available) {
    report.notes = ["ImageMagick is missing, so SVG rendering checks were skipped"];
    return { severity, report };
  }

  // librsvg delegate: without it ImageMagick falls back to its internal MSVG renderer.
  try {
    const delegates = await runCommand("magick", ["-list", "delegate"]);
    report.svg_rasterizer = /\bsvg\s*=>/.test(delegates)
      ? { status: "ok", delegate: "librsvg" }
      : {
          status: "warning",
          delegate: "internal MSVG",
          impact: "SVG stroke is ignored; build graphics from fills only",
        };
  } catch (error) {
    report.svg_rasterizer = { status: "warning", error: String(error?.message ?? error) };
  }
  severity = worst(severity, report.svg_rasterizer.status === "ok" ? "ok" : "warning");

  const workDirectory = await mkdtemp(join(tmpdir(), "lidfly-doctor-"));
  try {
    const strokeDrawn = await renderedInk(runCommand, workDirectory, "stroke", STROKE_SVG);
    report.svg_stroke_render = strokeDrawn
      ? { status: "ok" }
      : {
          status: "warning",
          impact: "outlines and card borders will silently disappear; use filled shapes instead",
          // A declared delegate is not proof it works: ImageMagick lists the
          // librsvg delegate even when the rsvg-convert binary is not installed,
          // and then quietly falls back to the internal renderer.
          ...(report.svg_rasterizer?.delegate === "librsvg"
            ? { note: "the librsvg delegate is declared but not functioning; check that rsvg-convert is installed" }
            : {}),
        };
    severity = worst(severity, strokeDrawn ? "ok" : "warning");

    // Which fonts can actually carry Russian copy and the ruble sign.
    const fonts = [];
    for (const font of FONT_CANDIDATES) {
      try {
        const [cyrillic, ruble] = [
          await renderedInk(runCommand, workDirectory, `cyr-${font.replace(/\W/g, "")}`, textSvg(font, "Тест")),
          await renderedInk(runCommand, workDirectory, `rub-${font.replace(/\W/g, "")}`, textSvg(font, "₽")),
        ];
        fonts.push({ font, cyrillic, ruble });
      } catch (error) {
        fonts.push({ font, error: String(error?.message ?? error) });
      }
    }
    report.fonts = fonts;
    const usable = fonts.filter((entry) => entry.cyrillic && entry.ruble).map((entry) => entry.font);
    report.recommended_font = usable[0] ?? null;
    if (usable.length === 0) {
      report.font_warning = "No candidate font renders both Cyrillic and the ruble sign";
      severity = worst(severity, "warning");
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }

  return { severity, report };
}

/**
 * Read-only environment report: provider credentials plus the local toolchain.
 * Makes no paid call and writes nothing outside a temporary directory.
 */
export async function runDoctor({
  createEvolinkClient,
  runCommand,
  env = process.env,
  checkOpenChatCut: checkEditor = () => checkOpenChatCut({ env }),
} = {}) {
  const report = {
    evolink_key_configured: Boolean(env.EVOLINK_API_KEY),
    komend_token_configured: Boolean(env.TTS_KOMEND_AUTH_TOKEN),
    evolink_auth: "not_checked",
    evolink_credits_available: null,
  };
  let severity = report.evolink_key_configured ? "ok" : "warning";

  if (report.evolink_key_configured && createEvolinkClient) {
    try {
      const credits = await createEvolinkClient().getCredits();
      const token = credits.data.token;
      const user = credits.data.user;
      report.evolink_auth = "ok";
      report.evolink_credits_available = Boolean(
        token.unlimited_credits || (token.remaining_credits > 0 && user.remaining_credits > 0),
      );
      if (!report.evolink_credits_available) severity = worst(severity, "warning");
    } catch (error) {
      Object.assign(report, {
        evolink_auth: "failed",
        evolink_auth_error: String(error?.message ?? error),
      });
      severity = worst(severity, "error");
    }
  }

  // verify-speech transcribes; without an ASR endpoint it cannot run at all, and
  // that used to be discovered only when someone tried to use it.
  report.speech_verification = env.KOMEND_ASR_ENDPOINT
    ? { asr_endpoint_configured: true, transcription: "available" }
    : {
        asr_endpoint_configured: false,
        transcription: "unavailable",
        impact: "verify-speech cannot check what was actually said",
        fallback: "detect-speech flags speech-like audio without transcribing it, as a warning only",
      };
  if (!env.KOMEND_ASR_ENDPOINT) severity = worst(severity, "warning");

  const tooling = await checkTooling({ ...(runCommand ? { runCommand } : {}) });
  report.tooling = tooling.report;
  severity = worst(severity, tooling.severity);

  // The interactive editing route. Its absence degrades the report rather than
  // failing it: the manifest assembler still builds masters without it.
  const editor = await checkEditor();
  report.openchatcut = editor;
  severity = worst(severity, editor?.status === "error" ? "error" : editor?.status === "warning" ? "warning" : "ok");
  report.status = severity;
  return report;
}
