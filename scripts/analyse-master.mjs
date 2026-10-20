#!/usr/bin/env node
// Разбор собранного мастера: то, что не видно глазом по контрольному листу.
//
// Статичный кадр выглядит как нормальный — на стоп-кадре не отличить панораму
// от неподвижной камеры. Если все планы оказались статичными,
// заметить это удаётся измерением: различие первого и последнего кадра
// сегмента держится на 12-19%, то есть объясняется одной мимикой.
//
//   node scripts/analyse-master.mjs <master.mp4> <edit-manifest.json>
//
// Скрипт ничего не меняет и никуда не ходит: только ffmpeg, ffprobe и magick.

import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Ниже этого различия кадр считается статичным: остальное — мимика. */
const STATIC_BELOW = 0.22;
/** Кульминация обязана быть подвижнее остальных, а не спокойнее. */
const CLIMAX_HINT = /climax|кульмин/i;

async function frameAt(master, seconds, out) {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(seconds),
    "-i", master, "-frames:v", "1", "-vf", "scale=160:-1", out]);
}

/** Среднеквадратичное различие двух кадров, 0 — идентичны, 1 — противоположны. */
async function difference(a, b) {
  try {
    await run("magick", ["compare", "-metric", "RMSE", a, b, "null:"]);
    return 0;
  } catch (error) {
    const text = String(error.stderr ?? error.stdout ?? "");
    const match = text.match(/\(([0-9.]+)\)/);
    return match ? Number(match[1]) : Number.NaN;
  }
}

const [master, manifestPath] = process.argv.slice(2);
if (!master || !manifestPath) {
  console.error("usage: node scripts/analyse-master.mjs <master.mp4> <edit-manifest.json>");
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const fps = manifest.output?.frame_rate ?? 24;
const work = await mkdtemp(join(tmpdir(), "analyse-master-"));

try {
  // Позиции сегментов не хранятся в манифесте намеренно — они накапливаются
  // из числа кадров, поэтому считаем их здесь тем же способом.
  let cursor = 0;
  const segments = manifest.segments.map((s) => {
    const start = cursor / fps;
    cursor += s.frames;
    return { id: s.id, start, duration: s.frames / fps, source: s.source };
  });

  const findings = [];
  const rows = [];

  for (const seg of segments) {
    const a = join(work, `${seg.id}-a.png`);
    const b = join(work, `${seg.id}-b.png`);
    await frameAt(master, seg.start + 0.3, a);
    await frameAt(master, seg.start + seg.duration - 0.3, b);
    const diff = await difference(a, b);
    rows.push({ ...seg, diff });
    if (diff < STATIC_BELOW) {
      findings.push({ level: "warning", code: "static_shot", segment: seg.id,
        message: `${seg.id}: различие первого и последнего кадра ${(diff * 100).toFixed(1)}% — камера неподвижна, в кадре меняется только мимика` });
    }
  }

  // Кульминация спокойнее среднего — верный признак, что пик не сыгран.
  const climax = rows.find((r) => CLIMAX_HINT.test(r.id));
  if (climax) {
    const others = rows.filter((r) => r !== climax);
    const mean = others.reduce((acc, r) => acc + r.diff, 0) / Math.max(1, others.length);
    if (climax.diff < mean) {
      findings.push({ level: "warning", code: "climax_is_the_stillest", segment: climax.id,
        message: `${climax.id}: кульминация статичнее среднего по ролику (${(climax.diff * 100).toFixed(1)}% против ${(mean * 100).toFixed(1)}%) — пик не сыгран движением` });
    }
  }

  // Ровный метр: если почти все сегменты одной длины, ролик идёт одним пульсом.
  const lengths = rows.map((r) => Number(r.duration.toFixed(2)));
  const spread = Math.max(...lengths) - Math.min(...lengths);
  if (spread <= 1.01) {
    findings.push({ level: "warning", code: "flat_metre",
      message: `длительности сегментов различаются на ${spread.toFixed(2)} с (${lengths.join(" / ")}) — ровный метр, ролик идёт одним пульсом от начала до конца` });
  }

  // Подряд идущие одинаковые крупности: берём из шот-плана, если он рядом.
  const planPath = manifestPath.replace(/edits\/.*$/, "brief/shotplan.json");
  let sizes = null;
  try {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    sizes = manifest.segments.map((s) => {
      const shot = plan.shots.find((x) => s.id.toLowerCase().includes(x.shot_id.toLowerCase()));
      return { id: s.id, size: shot?.shot_size ?? null };
    });
  } catch { /* плана рядом нет — проверка крупностей пропускается */ }

  if (sizes) {
    let runStart = 0;
    for (let i = 1; i <= sizes.length; i += 1) {
      const same = i < sizes.length && sizes[i].size && sizes[i].size === sizes[runStart].size;
      if (!same) {
        const runLength = i - runStart;
        if (runLength > 2 && sizes[runStart].size) {
          findings.push({ level: "warning", code: "shot_size_run", segment: sizes[runStart].id,
            message: `${runLength} сегмента подряд одной крупности (${sizes[runStart].size}): ${sizes.slice(runStart, i).map((s) => s.id).join(", ")}` });
        }
        runStart = i;
      }
    }
  }

  console.log(JSON.stringify({
    master,
    segments: rows.map((r) => ({
      id: r.id,
      start_seconds: Number(r.start.toFixed(2)),
      duration_seconds: Number(r.duration.toFixed(2)),
      frame_difference_percent: Number((r.diff * 100).toFixed(1)),
      verdict: r.diff < STATIC_BELOW ? "статичен" : "есть движение",
    })),
    findings,
    ok: findings.length === 0,
  }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
