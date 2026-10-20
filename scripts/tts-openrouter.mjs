#!/usr/bin/env node

/**
 * Синтез закадрового голоса через OpenRouter.
 *
 * Маршрут проверен 2026-08-27: POST /api/v1/audio/speech принимает
 * { model, input, voice, response_format } и отдаёт сырой PCM
 * (s16le, 24000 Гц, моно). Это не chat/completions: там модель с выходной
 * модальностью speech отбивается маршрутизатором.
 *
 * Реплики, голос и целевые длительности берутся из манифеста проекта,
 * поэтому озвучку можно повторить без переписки.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, join } from "node:path";
import { loadEnvFile } from "../src/config/env.mjs";

const run = promisify(execFile);

const ENDPOINT = "https://openrouter.ai/api/v1/audio/speech";
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
/** Порог и минимальная длительность тишины, которую режем по краям синтеза. */
const SILENCE_THRESHOLD_DB = -40;
const SILENCE_MIN_SECONDS = 0.02;

function usage() {
  process.stdout.write(`Синтез закадрового голоса через OpenRouter

Usage:
  node scripts/tts-openrouter.mjs --manifest <path> [--only <line_id>] [--force]

Манифест: { model, voice, output_dir, lines: [{ id, shot_id, text, target_seconds }] }
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "force" || name === "help") {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function durationSeconds(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", path,
  ]);
  return Number(stdout.trim());
}

/**
 * Тишина по краям синтеза — не безобидная: окна речи внутри шотов посчитаны
 * по кадру и запаса не имеют, поэтому режем её до записи результата.
 */
async function trimEdges(source, target) {
  const filter =
    `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD_DB}dB:start_silence=${SILENCE_MIN_SECONDS},` +
    `areverse,` +
    `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD_DB}dB:start_silence=${SILENCE_MIN_SECONDS},` +
    `areverse`;
  await run("ffmpeg", ["-y", "-v", "error", "-i", source, "-af", filter, target]);
}

async function synthesize({ apiKey, model, voice, text }) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text, voice, response_format: "pcm" }),
  });
  if (!response.ok) {
    // Тело ошибки провайдера сохраняем, но ключ в него попасть не может.
    const detail = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${detail.slice(0, 500)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.manifest) throw new TypeError("--manifest is required");

  await loadEnvFile();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const manifestPath = resolve(options.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const outputDir = resolve(dirname(manifestPath), manifest.output_dir ?? ".");
  await mkdir(outputDir, { recursive: true });

  const lines = manifest.lines.filter((line) => !options.only || line.id === options.only);
  if (!lines.length) throw new Error(`No lines matched --only ${options.only}`);

  const results = [];
  for (const line of lines) {
    const rawPath = join(outputDir, `${line.id}.raw.pcm`);
    const wavPath = join(outputDir, `${line.id}.wav`);
    const trimmedPath = join(outputDir, `${line.id}.trimmed.wav`);

    // Уже полученную озвучку не перезаписываем: это такой же артефакт, как дубль.
    if ((await exists(trimmedPath)) && !options.force) {
      results.push({ id: line.id, status: "reused", path: trimmedPath });
      continue;
    }

    const audio = await synthesize({
      apiKey,
      model: manifest.model,
      voice: manifest.voice,
      text: line.text,
    });
    await writeFile(rawPath, audio);
    await run("ffmpeg", [
      "-y", "-v", "error",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
      "-i", rawPath, wavPath,
    ]);
    await trimEdges(wavPath, trimmedPath);

    const raw = await durationSeconds(wavPath);
    const trimmed = await durationSeconds(trimmedPath);
    const target = line.target_seconds ?? null;
    results.push({
      id: line.id,
      shot_id: line.shot_id ?? null,
      status: "synthesized",
      path: trimmedPath,
      raw_seconds: Number(raw.toFixed(3)),
      trimmed_seconds: Number(trimmed.toFixed(3)),
      target_seconds: target,
      // Реплика, не помещающаяся в свой шот, — это не мелочь: монтаж либо
      // обрежет её, либо растянет кадр, и то и другое видно.
      fits: target === null ? null : trimmed <= target,
      words: line.text.split(/\s+/).filter(Boolean).length,
    });
  }

  const resultPath = join(outputDir, "voiceover-result.json");
  const payload = {
    schema_version: 1,
    model: manifest.model,
    voice: manifest.voice,
    route: ENDPOINT,
    audio_format: { encoding: "s16le", sample_rate: SAMPLE_RATE, channels: CHANNELS },
    synthesized_at: new Date().toISOString(),
    results,
  };
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
