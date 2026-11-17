import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "../core/hashing.mjs";
import { assertSafeWorkspacePath, exists, mkdirSafe, pathIsInside, readJson, resolveWorkspaceRoot } from "../core/workspace-files.mjs";
import { probeMedia } from "../media/ffmpeg.mjs";
import { resolveProjectRegistry } from "./asset-registry.mjs";

const MODULE_WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CATALOG_FILE = "projects.md";
const DELIVERY_DIR = "delivery";
const FINAL_RECORD = /^final-master-B([1-9]\d*)\.json$/;
const MASTER_FILE = /^(.+)-master-v([1-9]\d*)\.mp4$/;
const VIDEO_FILE = /\.(mp4|mov)$/i;

const STATUS_LABELS = Object.freeze({
  final: "✅ готов",
  assembled: "🟡 собран, итог не отмечен",
  in_progress: "🔵 в работе",
  planning: "⚪ план",
});

/** Every file below `root`, skipping dot-files; missing roots are empty. */
async function walk(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function listDirs(root) {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Masters are `<variant>-master-vN.mp4` outside `_intermediates`; anything else is a by-product. */
export function classifyMasters(files, mastersRoot) {
  const variants = new Map();
  let other = 0;
  for (const file of files) {
    if (!VIDEO_FILE.test(file.path)) continue;
    const parts = relative(mastersRoot, file.path).split(sep);
    const match = MASTER_FILE.exec(basename(file.path));
    if (!match || parts.some((part) => part.startsWith("_"))) {
      other += 1;
      continue;
    }
    const variant = match[1];
    const version = Number(match[2]);
    const list = variants.get(variant) ?? [];
    list.push({ ...file, variant, version });
    variants.set(variant, list);
  }
  const result = [...variants.entries()].map(([variant, versions]) => {
    versions.sort((a, b) => a.version - b.version);
    return { variant, versions, latest: versions.at(-1) };
  });
  result.sort((a, b) => b.latest.mtimeMs - a.latest.mtimeMs || a.variant.localeCompare(b.variant));
  return { variants: result, other };
}

async function latestFinalRecord(registryRoot) {
  const directory = join(registryRoot, DELIVERY_DIR);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const records = names.map((name) => [name, FINAL_RECORD.exec(name)]).filter(([, match]) => match)
    .sort((a, b) => Number(b[1][1]) - Number(a[1][1]));
  if (!records.length) return null;
  const [name, match] = records[0];
  const path = join(directory, name);
  return { ...await readJson(path, "Final master record"), record_path: path, record_version: Number(match[1]) };
}

/** A project's H1 when the manifest title is a placeholder such as "Видео №9". */
async function scriptHeading(path) {
  try {
    const text = await readFile(path, "utf8");
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    return heading?.replace(/^Режисс[её]рский сценарий( клипа)?:\s*/i, "").replace(/\s*\(`[^`]+`\)\s*$/, "") || null;
  } catch {
    return null;
  }
}

async function fileInfo(path) {
  const info = await stat(path);
  return { path, size: info.size, mtimeMs: info.mtimeMs };
}

async function safeProbe(path, tools) {
  try {
    const measured = await tools.probeMedia(path);
    return {
      duration_seconds: measured.duration_seconds || null,
      width: measured.video?.width ?? null,
      height: measured.video?.height ?? null,
    };
  } catch {
    return null;
  }
}

async function describeProject(workspaceRoot, registryRoot, tools) {
  const manifest = await readJson(join(registryRoot, "project.json"), "Project manifest");
  const storage = manifest.storage ?? {};
  const mastersRoot = resolve(workspaceRoot, storage.masters_root ?? "");
  const jobsRoot = resolve(workspaceRoot, storage.jobs_root ?? "");
  const masterFiles = storage.masters_root
    ? await Promise.all((await walk(mastersRoot)).map(fileInfo))
    : [];
  const { variants, other } = classifyMasters(masterFiles, mastersRoot);
  const takes = storage.jobs_root ? (await walk(jobsRoot)).filter((path) => VIDEO_FILE.test(path)).length : 0;
  const reviews = (await walk(join(registryRoot, "reviews"))).filter((path) => path.endsWith(".review.json")).length;

  const scriptPath = join(registryRoot, "brief/source-script.md");
  const planPath = join(registryRoot, "brief/shotplan.json");
  const hasScript = await exists(scriptPath);
  const hasPlan = await exists(planPath);
  let aspectRatio = null;
  if (hasPlan) {
    try {
      aspectRatio = (await readJson(planPath, "Shot plan")).target?.aspect_ratio ?? null;
    } catch {
      aspectRatio = null;
    }
  }
  const statusFiles = (await walk(join(registryRoot, "brief")))
    .filter((path) => /production-status-B\d+\.json$/.test(path))
    .sort((a, b) => Number(/B(\d+)\.json$/.exec(a)[1]) - Number(/B(\d+)\.json$/.exec(b)[1]));

  let title = manifest.title ?? manifest.project_id;
  if (/^Видео №\d+$/.test(title) && hasScript) {
    const heading = await scriptHeading(scriptPath);
    if (heading) title = heading;
  }

  let final = await latestFinalRecord(registryRoot);
  if (final) {
    const absolute = resolve(workspaceRoot, final.path);
    final.exists = await exists(absolute);
    final.intact = final.exists && await hashFile(absolute) === final.sha256;
    final.absolute = absolute;
  }

  const shown = new Set([final?.absolute, ...variants.map((item) => item.latest.path)].filter(Boolean));
  const measured = new Map();
  for (const path of shown) {
    if (await exists(path)) measured.set(path, await safeProbe(path, tools));
  }

  const status = final?.intact ? "final" : variants.length ? "assembled" : takes || reviews ? "in_progress" : "planning";
  const timestamps = [...masterFiles.map((file) => file.mtimeMs), (await stat(registryRoot)).mtimeMs];
  return {
    client_id: manifest.client_id,
    project_id: manifest.project_id,
    video_number: manifest.video_number,
    title,
    created_at: manifest.created_at ?? null,
    updated_at: new Date(Math.max(...timestamps)).toISOString(),
    aspect_ratio: aspectRatio,
    status,
    registry_root: registryRoot,
    masters_root: storage.masters_root ? mastersRoot : null,
    jobs_root: storage.jobs_root ? jobsRoot : null,
    script: hasScript ? scriptPath : null,
    plan: hasPlan ? planPath : null,
    production_status: statusFiles.at(-1) ?? null,
    takes,
    reviews,
    other_master_files: other,
    variants,
    final,
    measured,
  };
}

/** Scan `projects/<client>/V*` and the artifacts each manifest points to. Read-only. */
export async function scanProjects({ workspaceRoot } = {}, tools = { probeMedia }) {
  const workspace = await resolveWorkspaceRoot(workspaceRoot, MODULE_WORKSPACE_ROOT);
  const projectsRoot = join(workspace, "projects");
  const clients = [];
  for (const clientId of await listDirs(projectsRoot)) {
    const clientRoot = join(projectsRoot, clientId);
    let displayName = clientId;
    if (await exists(join(clientRoot, "client.json"))) {
      displayName = (await readJson(join(clientRoot, "client.json"), "Client manifest")).display_name ?? clientId;
    }
    const projects = [];
    for (const name of await listDirs(clientRoot)) {
      if (!/^V\d+$/.test(name)) continue;
      const registryRoot = join(clientRoot, name);
      if (!await exists(join(registryRoot, "project.json"))) continue;
      try {
        projects.push(await describeProject(workspace, registryRoot, tools));
      } catch (error) {
        projects.push({ client_id: clientId, project_id: `${clientId}/${name}`, error: error.message, registry_root: registryRoot });
      }
    }
    projects.sort((a, b) => (b.video_number ?? 0) - (a.video_number ?? 0));
    if (projects.length) clients.push({ client_id: clientId, display_name: displayName, projects });
  }
  return { workspaceRoot: workspace, clients };
}

function link(text, path, workspaceRoot) {
  const target = relative(workspaceRoot, path).split(sep).join("/");
  return `[${text.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${target}>)`;
}

function cell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function anchor(projectId) {
  return projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;
}

function formatDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : "—";
}

function describeMedia(project, path, size) {
  const media = project.measured.get(path);
  return [
    formatDuration(media?.duration_seconds),
    media?.width && media?.height ? `${media.width}×${media.height}` : null,
    size ? formatSize(size) : null,
  ].filter(Boolean).join(", ");
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** The plan's ratio, else the ratio measured on the headline master. */
function formatAspect(project) {
  if (project.aspect_ratio) return project.aspect_ratio;
  const head = headline(project);
  const media = head && project.measured.get(head.path);
  if (!media?.width || !media?.height) return "—";
  const divisor = gcd(media.width, media.height);
  return `${media.width / divisor}:${media.height / divisor} (по мастеру)`;
}

/** The master to put in front of the user: the marked final, else the newest variant. */
function headline(project) {
  if (project.final?.intact) return { path: project.final.absolute, label: "итог" };
  const latest = project.variants[0]?.latest;
  return latest ? { path: latest.path, label: "последний", size: latest.size } : null;
}

export function renderCatalog({ workspaceRoot, clients }, { generatedAt = new Date() } = {}) {
  const lines = [
    "# Проекты видео",
    "",
    `> Собрано командой \`node src/cli.mjs catalog\` — ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC. Не правьте вручную: файл пересобирается из папок \`projects/\` и \`artifacts/\`.`,
    "> Итоговый мастер отмечается командой `node src/cli.mjs catalog final --project <путь> --file <мастер.mp4>`. Без отметки показан последний по времени мастер.",
    "",
    "Статусы: ✅ готов — итог отмечен · 🟡 собран — мастера есть, итог не выбран · 🔵 в работе — есть дубли · ⚪ план — только сценарий/план.",
    "",
    "## Сводка",
    "",
    "| Проект | Название | Статус | Мастер | Формат | Обновлён |",
    "|---|---|---|---|---|---|",
  ];
  for (const client of clients) {
    for (const project of client.projects) {
      if (project.error) {
        lines.push(`| ${cell(project.project_id)} | ⚠ ${cell(project.error)} | — | — | — | — |`);
        continue;
      }
      const head = headline(project);
      const master = head
        ? `${head.label === "итог" ? "▶ итог" : "▷ последний"}: ${link(basename(head.path), head.path, workspaceRoot)}`
        : "—";
      lines.push(`| [${project.project_id}](#${anchor(project.project_id)}) | ${cell(project.title)} | ${STATUS_LABELS[project.status]} | ${master} | ${formatAspect(project)} | ${formatDate(project.updated_at)} |`);
    }
  }

  for (const client of clients) {
    lines.push("", `## ${client.display_name} (\`${client.client_id}\`)`);
    for (const project of client.projects) {
      lines.push("", `<a id="${anchor(project.project_id)}"></a>`, "");
      if (project.error) {
        lines.push(`### ${project.project_id}`, "", `⚠ Не удалось прочитать проект: ${project.error}`);
        continue;
      }
      lines.push(`### ${project.project_id} — ${project.title}`, "");
      lines.push(`- **Статус:** ${STATUS_LABELS[project.status]} · создан ${formatDate(project.created_at)} · формат ${formatAspect(project)}`);
      if (project.final) {
        const final = project.final;
        const media = final.exists ? describeMedia(project, final.absolute) : "";
        const problem = !final.exists ? " — ⚠ файл не найден" : !final.intact ? " — ⚠ файл изменён после отметки (sha256 не совпадает)" : "";
        lines.push(`- **Итоговый мастер:** ${link(basename(final.path), resolve(workspaceRoot, final.path), workspaceRoot)}${media ? ` — ${media}` : ""}${problem}`);
        lines.push(`  - отмечен ${formatDate(final.marked_at)}${final.note ? ` · ${final.note}` : ""} · ${link(basename(final.record_path), final.record_path, workspaceRoot)}`);
      } else if (project.variants.length) {
        const latest = project.variants[0].latest;
        lines.push(`- **Итоговый мастер:** не отмечен. Последний по времени — ${link(basename(latest.path), latest.path, workspaceRoot)} — ${describeMedia(project, latest.path, latest.size)}`);
      } else {
        lines.push("- **Итоговый мастер:** мастеров пока нет");
      }
      if (project.variants.length) {
        lines.push(`- **Варианты монтажа** (${project.variants.length}):`);
        for (const { variant, versions, latest } of project.variants) {
          const older = versions.slice(0, -1).map((item) => link(`v${item.version}`, item.path, workspaceRoot)).join(" ");
          lines.push(`  - \`${variant}\` — ${link(`v${latest.version}`, latest.path, workspaceRoot)} (${describeMedia(project, latest.path, latest.size)}, ${formatDate(latest.mtimeMs)})${older ? ` · ранние: ${older}` : ""}`);
        }
      }
      const documents = [
        project.script && link("сценарий", project.script, workspaceRoot),
        project.plan && link("шот-план", project.plan, workspaceRoot),
        project.production_status && link("последний статус", project.production_status, workspaceRoot),
      ].filter(Boolean);
      if (documents.length) lines.push(`- **Документы:** ${documents.join(" · ")}`);
      const folders = [
        link("проект", project.registry_root, workspaceRoot),
        project.jobs_root && link("дубли", project.jobs_root, workspaceRoot),
        project.masters_root && link("мастера", project.masters_root, workspaceRoot),
      ].filter(Boolean);
      lines.push(`- **Папки:** ${folders.join(" · ")}`);
      lines.push(`- **Материал:** видео-дублей ${project.takes} · ревью ${project.reviews}${project.other_master_files ? ` · промежуточных файлов в мастерах ${project.other_master_files}` : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function writeTextAtomic(workspaceRoot, filePath, text) {
  const staging = join(dirname(filePath), `.${randomUUID()}.tmp`);
  await assertSafeWorkspacePath(workspaceRoot, staging, "catalog staging file");
  await writeFile(staging, text, { encoding: "utf8", flag: "wx" });
  try {
    await rename(staging, filePath);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
}

/** Rebuild `projects.md` in the workspace root from what is on disk. */
export async function buildCatalog({ workspaceRoot } = {}, tools = { probeMedia }) {
  const scan = await scanProjects({ workspaceRoot }, tools);
  const target = join(scan.workspaceRoot, CATALOG_FILE);
  await writeTextAtomic(scan.workspaceRoot, target, renderCatalog(scan));
  const projects = scan.clients.flatMap((client) => client.projects);
  return {
    path: target,
    projects: projects.length,
    by_status: Object.fromEntries(Object.keys(STATUS_LABELS).map((key) => [key, projects.filter((item) => item.status === key).length])),
  };
}

/**
 * Record the user's choice of final master as a new B-numbered record in
 * `<project>/delivery/`. Earlier choices stay on disk; the highest B wins.
 */
export async function markFinalMaster({ projectRoot, workspaceRoot, filePath, note }, tools = { probeMedia }) {
  const project = await resolveProjectRegistry({ projectRoot, workspaceRoot });
  const workspace = project.workspaceRoot;
  const mastersRoot = resolve(workspace, project.manifest.storage.masters_root);
  const source = resolve(filePath);
  if (!pathIsInside(mastersRoot, source)) {
    throw new Error(`Final master must be inside this project's masters root: ${relative(workspace, mastersRoot)}`);
  }
  await assertSafeWorkspacePath(workspace, source, "final master");
  if (!VIDEO_FILE.test(source) || !(await stat(source)).isFile()) throw new Error("Final master must be an existing .mp4/.mov file");
  const measured = await tools.probeMedia(source);
  if (!measured.video || !(measured.duration_seconds > 0)) throw new Error("Final master has no usable video stream");

  const directory = join(project.registryRoot, DELIVERY_DIR);
  await mkdirSafe(workspace, directory, "delivery directory");
  const previous = await latestFinalRecord(project.registryRoot);
  const version = (previous?.record_version ?? 0) + 1;
  const record = {
    schema_version: "final-master/1",
    client_id: project.manifest.client_id,
    project_id: project.manifest.project_id,
    video_number: project.manifest.video_number,
    path: relative(workspace, source).split(sep).join("/"),
    sha256: await hashFile(source),
    measured: {
      duration_seconds: measured.duration_seconds,
      width: measured.video.width,
      height: measured.video.height,
      audio: Boolean(measured.audio),
    },
    marked_at: new Date().toISOString(),
    ...(note ? { note: String(note) } : {}),
    ...(previous ? { supersedes: relative(workspace, previous.record_path).split(sep).join("/") } : {}),
  };
  const target = join(directory, `final-master-B${version}.json`);
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  const catalog = await buildCatalog({ workspaceRoot: workspace }, tools);
  return { record_path: target, ...record, catalog: catalog.path };
}
