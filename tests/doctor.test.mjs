import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";
import { checkTooling, runDoctor } from "../src/workflows/doctor.mjs";

/**
 * Stands in for the local toolchain so the checks themselves can be tested
 * without depending on what happens to be installed on the machine.
 *
 * `ink` decides, per render name, whether the fake renderer put anything on the
 * canvas — that is exactly the signal the real checks read from ImageMagick.
 */
function fakeRunner({ missing = [], delegates = "svg => rsvg-convert", ink = () => true } = {}) {
  const calls = [];
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args].join(" "));
      if (missing.includes(file)) {
        const error = new Error(`spawn ${file} ENOENT`);
        error.code = "ENOENT";
        throw error;
      }
      if (file === "ffmpeg" || file === "ffprobe") return `${file} version 8.1\nbuilt with clang`;
      if (args[0] === "--version") return "Version: ImageMagick 7.1.2-8 Q16-HDRI";
      if (args[0] === "-list") return delegates;
      if (args.includes("-format")) return ink(basename(args[0], ".png")) ? "0" : "1";
      return "";
    },
  };
}

test("a missing renderer is an error, not a warning", async () => {
  const runner = fakeRunner({ missing: ["ffmpeg"] });
  const { severity, report } = await checkTooling({ runCommand: runner.run });

  assert.equal(severity, "error");
  assert.equal(report.ffmpeg.available, false);
  assert.equal(report.ffmpeg.error, "not found on PATH");
  assert.equal(report.ffprobe.available, true);
});

test("SVG rendering checks are skipped when ImageMagick itself is absent", async () => {
  const runner = fakeRunner({ missing: ["magick"] });
  const { severity, report } = await checkTooling({ runCommand: runner.run });

  assert.equal(severity, "error");
  assert.equal(report.svg_stroke_render, undefined);
  assert.match(report.notes[0], /ImageMagick is missing/);
});

test("a silently dropped stroke is reported even while the delegate claims to be present", async () => {
  // The real machine: librsvg is listed as a delegate but stroke never lands.
  const runner = fakeRunner({ ink: (name) => name !== "stroke" });
  const { severity, report } = await checkTooling({ runCommand: runner.run });

  assert.equal(severity, "warning");
  assert.equal(report.svg_rasterizer.status, "ok");
  assert.equal(report.svg_stroke_render.status, "warning");
  assert.match(report.svg_stroke_render.impact, /silently disappear/);
  assert.match(report.svg_stroke_render.note, /declared but not functioning/);
});

test("an absent SVG delegate is flagged on its own", async () => {
  const runner = fakeRunner({ delegates: "dot => dot -Tsvg\npnm<= trace" });
  const { report } = await checkTooling({ runCommand: runner.run });

  assert.equal(report.svg_rasterizer.status, "warning");
  assert.equal(report.svg_rasterizer.delegate, "internal MSVG");
  // No misleading librsvg note when there is no librsvg to blame.
  assert.equal(report.svg_stroke_render.note, undefined);
});

test("fonts that drop the ruble sign are excluded from the recommendation", async () => {
  // Mirrors the real macOS result: only PT Sans carries both.
  const runner = fakeRunner({
    ink: (name) => (name.startsWith("rub-") ? name === "rub-PTSans" : true),
  });
  const { report } = await checkTooling({ runCommand: runner.run });

  assert.equal(report.recommended_font, "PT Sans");
  assert.deepEqual(
    report.fonts.find((entry) => entry.font === "Helvetica"),
    { font: "Helvetica", cyrillic: true, ruble: false },
  );
  assert.equal(report.font_warning, undefined);
});

test("no usable font at all is a warning with an explanation", async () => {
  const runner = fakeRunner({ ink: (name) => !name.startsWith("rub-") });
  const { severity, report } = await checkTooling({ runCommand: runner.run });

  assert.equal(severity, "warning");
  assert.equal(report.recommended_font, null);
  assert.match(report.font_warning, /No candidate font renders both/);
});

test("a healthy toolchain reports ok", async () => {
  const runner = fakeRunner();
  const { severity, report } = await checkTooling({ runCommand: runner.run });

  assert.equal(severity, "ok");
  assert.equal(report.svg_stroke_render.status, "ok");
  assert.equal(report.recommended_font, "PT Sans");
});

test("doctor reports credential state and never makes a paid call", async () => {
  const runner = fakeRunner();
  const report = await runDoctor({
    runCommand: runner.run,
    checkOpenChatCut: async () => ({ status: "ok", notes: [] }),
    env: {
      EVOLINK_API_KEY: "test-key",
      TTS_KOMEND_AUTH_TOKEN: "test-token",
      KOMEND_ASR_ENDPOINT: "https://asr.example/v1/recognize",
    },
    createEvolinkClient: () => ({
      async getCredits() {
        return {
          data: {
            token: { unlimited_credits: false, remaining_credits: 100 },
            user: { remaining_credits: 100 },
          },
        };
      },
    }),
  });

  assert.equal(report.status, "ok");
  assert.equal(report.evolink_auth, "ok");
  assert.equal(report.evolink_credits_available, true);
  assert.equal(report.komend_token_configured, true);
  assert.equal(report.speech_verification.transcription, "available");
  assert.ok(runner.calls.every((call) => /^(ffmpeg|ffprobe|magick)\b/.test(call)));
});

test("a missing ASR endpoint is reported as a warning, not discovered at use time", async () => {
  const report = await runDoctor({
    runCommand: fakeRunner().run,
    checkOpenChatCut: async () => ({ status: "ok", notes: [] }),
    env: { EVOLINK_API_KEY: "test-key", TTS_KOMEND_AUTH_TOKEN: "test-token" },
    createEvolinkClient: () => ({
      async getCredits() {
        return {
          data: {
            token: { unlimited_credits: true, remaining_credits: 0 },
            user: { remaining_credits: 0 },
          },
        };
      },
    }),
  });

  assert.equal(report.speech_verification.asr_endpoint_configured, false);
  assert.match(report.speech_verification.fallback, /detect-speech/);
  assert.equal(report.status, "warning");
});

test("a failing provider check is an error and is surfaced with its reason", async () => {
  const report = await runDoctor({
    runCommand: fakeRunner().run,
    checkOpenChatCut: async () => ({ status: "ok", notes: [] }),
    env: { EVOLINK_API_KEY: "test-key" },
    createEvolinkClient: () => ({
      async getCredits() {
        throw new Error("EVOLINK credits HTTP 401: invalid key");
      },
    }),
  });

  assert.equal(report.status, "error");
  assert.equal(report.evolink_auth, "failed");
  assert.match(report.evolink_auth_error, /401/);
  assert.equal(report.komend_token_configured, false);
});

test("an unavailable OpenChatCut route degrades doctor to a warning and is reported in full", async () => {
  const editor = {
    status: "warning",
    notes: ["OpenChatCut checkout not found at /work/OpenChatCut; run: node src/cli.mjs openchatcut install"],
    checkout: { present: false },
  };
  const report = await runDoctor({
    runCommand: fakeRunner().run,
    checkOpenChatCut: async () => editor,
    env: {
      EVOLINK_API_KEY: "test-key",
      TTS_KOMEND_AUTH_TOKEN: "test-token",
      KOMEND_ASR_ENDPOINT: "https://asr.example/v1/recognize",
    },
    createEvolinkClient: () => ({
      async getCredits() {
        return {
          data: {
            token: { unlimited_credits: true, remaining_credits: 0 },
            user: { remaining_credits: 0 },
          },
        };
      },
    }),
  });

  assert.equal(report.status, "warning");
  assert.deepEqual(report.openchatcut, editor);
});
