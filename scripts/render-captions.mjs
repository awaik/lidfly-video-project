#!/usr/bin/env node

/**
 * Рендер титров и субтитров как PNG-оверлеев.
 *
 * Титры не закрывают кадр: подложки нет, читаемость на светлом плане
 * набирается весом шрифта и мягкой тенью. Обводку не используем — доктор
 * репозитория сообщает, что растеризатор SVG молча игнорирует stroke, а
 * тонкая обводка всё равно пропадает при уменьшении.
 */

import { readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";

const run = promisify(execFile);

const FONT_REGULAR = "PT-Sans";
const FONT_BOLD = "PT-Sans-Bold";
/** Тень мягкая и тёмная: на светлом кадре она держит белый текст без плашки. */
const SHADOW = "#00000088";
const TEXT = "#FFFFFFF2";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index].replace(/^--/, "");
    options[name] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.spec) throw new TypeError("--spec <captions.json> is required");
  const specPath = resolve(options.spec);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const outDir = resolve(dirname(specPath), spec.output_dir ?? ".");
  await mkdir(outDir, { recursive: true });

  const built = [];
  for (const item of spec.captions) {
    const width = item.width ?? spec.width ?? 1080;
    const height = item.height ?? Math.round((item.size ?? 56) * 1.9);
    const font = item.bold === false ? FONT_REGULAR : FONT_BOLD;
    const target = join(outDir, `${item.id}.png`);
    await run("magick", [
      "-size", `${width}x${height}`, "xc:none",
      "-font", font, "-pointsize", String(item.size ?? 56), "-gravity", "center",
      // тень рисуется тем же текстом со смещением, отдельным слоем
      "-fill", SHADOW, "-annotate", "+3+4", item.text,
      "-fill", item.color ?? TEXT, "-annotate", "+0+0", item.text,
      "-define", "png:color-type=6", `PNG32:${target}`,
    ]);
    built.push({ id: item.id, path: target, width, height });
  }
  process.stdout.write(`${JSON.stringify({ built: built.length, output_dir: outDir }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
