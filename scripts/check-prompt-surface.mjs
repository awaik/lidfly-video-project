#!/usr/bin/env node

/**
 * Проверка промпт-поверхности шот-плана на словесные ловушки.
 *
 * Ловит то, что машинные проверки плана не видят, а модель отыгрывает
 * буквально: отрицание в утвердительном поле (иногда исполняется наоборот),
 * ссылку на соседний шот (модель его не видела), просьбу о синхронной речи
 * и о надписи в кадре, режиссёрское намерение вместо изображения и
 * упоминание референса там, где его не подают.
 *
 * Usage: node scripts/check-prompt-surface.mjs --project projects/<client>/V<NNN>
 */

const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
if (projectIndex === -1 || !args[projectIndex + 1]) {
  process.stderr.write("--project projects/<client>/V<NNN> is required\n");
  process.exit(1);
}
const project = args[projectIndex + 1];
const root = process.cwd();
const { composeShotPrompt } = await import(`${root}/src/domain/shot-prompt.mjs`);
const fs = await import("node:fs/promises");
const plan = JSON.parse(await fs.readFile(`${root}/${project}/brief/shotplan.json`, "utf8"));
const cont = JSON.parse(await fs.readFile(`${root}/${project}/brief/continuity.json`, "utf8"));
const traps = [
  [/reference image/i, "ссылка на референс"],
  [/\b(no|never|without|nothing|neither|nor)\b/i, "отрицание в утвердительной части"],
  [/\b(does not|do not|is not|are not|cannot|can't|won't|doesn't|isn't)\b/i, "скрытое отрицание"],
  [/\b(earlier|previous|same as|another) shot\b/i, "ссылка на другой шот"],
  [/\b(speak|talking|lips|mouth)\b/i, "просьба о синхронной речи"],
  [/\b(title|caption|overlay|logo|text)\b/i, "надпись в кадре"],
  [/[А-Яа-яЁё]/, "кириллица"],
  [/\b(instead of|rather than|nobody|no one)\b/i, "намерение вместо изображения"],
  [/\b(of the film|in every shot|earlier|the same as)\b/i, "мета-фраза про монтаж"],
];
let bad = 0;
for (const shot of plan.shots) {
  if (shot.source !== "generated") continue;
  const { prompt } = composeShotPrompt({ plan, continuity: cont, shot });
  const positive = prompt.replace(cont.negative_prompt_block, "");
  for (const [re, label] of traps) {
    if (label === "ссылка на референс" && shot.identity_refs.length) continue;
    const m = positive.match(re);
    if (m) { bad++; console.log(`⚠ ${shot.shot_id}: ${label} → «${m[0]}»`); }
  }
}
console.log(bad ? `\nнайдено проблем: ${bad}` : "промпт-поверхность чистая");
if (bad) process.exitCode = 1;
