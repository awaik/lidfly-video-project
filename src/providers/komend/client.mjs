import { createWriteStream } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { providerErrorFromResponse } from "../../core/errors.mjs";
import { oneOf, requiredString } from "../../core/validation.mjs";

export const KOMEND_VOICES = Object.freeze({
  female: "ru_zhadyra",
  neutral: "ru_zhadyra",
  male: "ru_roman",
  ru_zhadyra: "ru_zhadyra",
  ru_roman: "ru_roman",
});

export class KomendClient {
  constructor({
    authToken = process.env.TTS_KOMEND_AUTH_TOKEN,
    endpoint = process.env.KOMEND_TTS_ENDPOINT ?? null,
    // Speech recognition lives on the same service, but its route is not
    // documented here, so it must be configured explicitly rather than guessed.
    asrEndpoint = process.env.KOMEND_ASR_ENDPOINT ?? null,
    fetchFn = globalThis.fetch,
  } = {}) {
    if (!authToken) throw new TypeError("TTS_KOMEND_AUTH_TOKEN is not configured");
    this.authToken = authToken;
    this.endpoint = endpoint;
    this.asrEndpoint = asrEndpoint;
    this.fetch = fetchFn;
  }

  /**
   * Transcribe an audio file so a generated take's speech can be checked against
   * the line it was asked to say.
   *
   * The response shape is read defensively: several common field names are
   * accepted, because the exact contract of this route is not pinned down here.
   */
  async transcribe({ audioPath, language = "ru" }) {
    if (!this.asrEndpoint) {
      throw new TypeError(
        "KOMEND_ASR_ENDPOINT is not configured; set it to the speech-recognition route before verifying speech. Without it there is no transcription: node src/cli.mjs detect-speech --job <dir> only flags speech-like audio",
      );
    }
    const path = requiredString(audioPath, "audioPath");
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const audio = await readFile(path);

    const body = new FormData();
    body.set("file", new Blob([audio]), basename(path));
    body.set("language", requiredString(language, "language"));

    const response = await this.fetch(this.asrEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.authToken}`, Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw await providerErrorFromResponse(response, "Komend transcription");

    const payload = await response.json();
    const text =
      payload?.text ?? payload?.transcript ?? payload?.result?.text ?? payload?.data?.text ?? null;
    if (typeof text !== "string") {
      throw new TypeError(
        `Komend transcription returned no recognizable text field (got: ${Object.keys(payload ?? {}).join(", ") || "empty body"})`,
      );
    }
    return {
      provider: "komend",
      endpoint: this.asrEndpoint,
      language,
      text,
      ...(payload?.duration === undefined ? {} : { duration_seconds: Number(payload.duration) }),
    };
  }

  async synthesize({ text, voice = "neutral", format = "mp3", outputPath }) {
    if (!this.endpoint) {
      throw new TypeError("KOMEND_TTS_ENDPOINT is not configured");
    }
    const normalizedText = requiredString(text, "text");
    const normalizedVoice = oneOf(voice, "voice", Object.keys(KOMEND_VOICES), "neutral");
    const normalizedFormat = oneOf(format, "format", ["mp3", "wav"], "mp3");
    const path = requiredString(outputPath, "outputPath");
    if (extname(path).toLowerCase() !== `.${normalizedFormat}`) {
      throw new TypeError(`outputPath must end with .${normalizedFormat}`);
    }

    const body = new URLSearchParams({
      text: normalizedText,
      voice: KOMEND_VOICES[normalizedVoice],
      format: normalizedFormat,
    });
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        Accept: normalizedFormat === "mp3" ? "audio/mpeg" : "audio/wav",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await providerErrorFromResponse(response, "Komend TTS synthesis");
    if (!response.body) throw new TypeError("Komend TTS returned an empty audio body");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
    if (contentType && contentType !== "application/octet-stream" && !contentType.startsWith("audio/")) {
      await response.body.cancel();
      throw new TypeError(`Komend TTS returned incompatible Content-Type: ${contentType}`);
    }
    await mkdir(dirname(path), { recursive: true });
    const partialPath = `${path}.partial`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
    await link(partialPath, path);
    await unlink(partialPath);
    return {
      provider: "komend",
      model: "v5_cis_base_nostress",
      voice_id: KOMEND_VOICES[normalizedVoice],
      format: normalizedFormat,
      text_length: normalizedText.length,
      output_path: path,
    };
  }
}
