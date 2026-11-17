import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectManifest } from '../src/domain/production-context.mjs';
import { buildCatalog, markFinalMaster, scanProjects } from '../src/workflows/catalog.mjs';

const media = { probeMedia: async () => ({ duration_seconds: 61, video: { width: 1080, height: 1920 }, audio: {} }) };

async function project(workspaceRoot, clientId, videoNumber, title) {
  const v = `V${String(videoNumber).padStart(3, '0')}`;
  const storage = {
    mode: 'standard', project_root: `projects/${clientId}/${v}`, jobs_root: `artifacts/${clientId}/${v}/jobs`,
    audio_root: `artifacts/${clientId}/${v}/audio`, masters_root: `artifacts/${clientId}/${v}/masters`,
  };
  const root = join(workspaceRoot, storage.project_root);
  await mkdir(join(root, 'brief'), { recursive: true });
  await writeFile(join(root, 'project.json'), JSON.stringify(createProjectManifest({
    clientId, videoNumber, title, createdAt: '2026-10-01T00:00:00Z', storage })));
  return { root, masters: join(workspaceRoot, storage.masters_root), jobs: join(workspaceRoot, storage.jobs_root) };
}

async function fixture() {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'catalog-')));
  const done = await project(workspaceRoot, 'demo', 1, 'Готовый ролик');
  await mkdir(join(done.masters, 'E001/_intermediates'), { recursive: true });
  await writeFile(join(done.masters, 'E001/E001-master-v1.mp4'), 'v1');
  await writeFile(join(done.masters, 'E001/E001-master-v2.mp4'), 'v2');
  await writeFile(join(done.masters, 'E001/_intermediates/seg1-master-v9.mp4'), 'seg');
  await writeFile(join(done.masters, 'E001/E001-master-v2.report.json'), '{}');
  const draft = await project(workspaceRoot, 'demo', 2, 'Видео №2');
  await writeFile(join(draft.root, 'brief/source-script.md'), '# Режиссёрский сценарий клипа: «Луна» (`X`)\n');
  await mkdir(join(draft.jobs, 'browser/S001/B1'), { recursive: true });
  await writeFile(join(draft.jobs, 'browser/S001/B1/original.mp4'), 'take');
  return { workspaceRoot, done, draft };
}

test('scan finds masters, ignores intermediates and reports honest status', async () => {
  const f = await fixture();
  const { clients } = await scanProjects({ workspaceRoot: f.workspaceRoot }, media);
  const [v2, v1] = clients[0].projects;
  assert.equal(v1.status, 'assembled');
  assert.deepEqual(v1.variants.map((x) => [x.variant, x.latest.version, x.versions.length]), [['E001', 2, 2]]);
  assert.equal(v1.other_master_files, 1);
  assert.equal(v2.status, 'in_progress');
  assert.equal(v2.takes, 1);
  assert.equal(v2.title, '«Луна»');
});

test('catalog writes projects.md in the workspace root with relative links', async () => {
  const f = await fixture();
  const result = await buildCatalog({ workspaceRoot: f.workspaceRoot }, media);
  assert.equal(result.path, join(f.workspaceRoot, 'projects.md'));
  const text = await readFile(result.path, 'utf8');
  assert.match(text, /\[E001-master-v2\.mp4\]\(<artifacts\/demo\/V001\/masters\/E001\/E001-master-v2\.mp4>\)/);
  assert.match(text, /9:16 \(по мастеру\)/);
  assert.doesNotMatch(text, /seg1-master-v9/);
  assert.doesNotMatch(text, new RegExp(f.workspaceRoot));
});

test('final mark is a new B record, rebuilds the catalog and keeps earlier choices', async () => {
  const f = await fixture();
  const first = await markFinalMaster({ projectRoot: 'projects/demo/V001', workspaceRoot: f.workspaceRoot,
    filePath: join(f.done.masters, 'E001/E001-master-v1.mp4'), note: 'для клиента' }, media);
  assert.equal(first.path, 'artifacts/demo/V001/masters/E001/E001-master-v1.mp4');
  await markFinalMaster({ projectRoot: 'projects/demo/V001', workspaceRoot: f.workspaceRoot,
    filePath: join(f.done.masters, 'E001/E001-master-v2.mp4') }, media);
  assert.deepEqual((await readdir(join(f.done.root, 'delivery'))).sort(), ['final-master-B1.json', 'final-master-B2.json']);
  const text = await readFile(join(f.workspaceRoot, 'projects.md'), 'utf8');
  assert.match(text, /✅ готов \| ▶ итог: \[E001-master-v2\.mp4\]/);
});

test('final mark refuses files outside the project masters and flags later changes', async () => {
  const f = await fixture();
  const outside = join(f.workspaceRoot, 'elsewhere.mp4');
  await writeFile(outside, 'x');
  await assert.rejects(markFinalMaster({ projectRoot: 'projects/demo/V001', workspaceRoot: f.workspaceRoot, filePath: outside }, media),
    /inside this project's masters root/);
  await assert.rejects(markFinalMaster({ projectRoot: 'projects/demo/V001', workspaceRoot: f.workspaceRoot,
    filePath: join(f.done.masters, 'E001/E001-master-v1.mp4') }, { probeMedia: async () => ({ duration_seconds: 1, video: null }) }),
  /no usable video/);
  const master = join(f.done.masters, 'E001/E001-master-v2.mp4');
  await markFinalMaster({ projectRoot: 'projects/demo/V001', workspaceRoot: f.workspaceRoot, filePath: master }, media);
  await writeFile(master, 'edited');
  const { clients } = await scanProjects({ workspaceRoot: f.workspaceRoot }, media);
  const done = clients[0].projects.find((x) => x.project_id.endsWith('V001'));
  assert.equal(done.status, 'assembled');
  assert.equal(done.final.intact, false);
});
