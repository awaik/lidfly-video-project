import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectManifest } from '../src/domain/production-context.mjs';
import { normalizeShotPlan, shotPlanHash } from '../src/domain/shot-plan.mjs';
import { normalizeContinuity, continuityHash } from '../src/domain/continuity.mjs';
import { normalizeVideoRequest } from '../src/domain/video-request.mjs';
import { composeShotRequests } from '../src/workflows/shot-plan.mjs';
import { importBrowserTake } from '../src/workflows/browser-video.mjs';
import { hashFile } from '../src/core/hashing.mjs';
import { shotPlanFindings } from '../src/domain/shot-plan-checks.mjs';

const json = (path, data) => writeFile(path, JSON.stringify(data));
async function fixture() {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'browser-video-')));
  const projectRoot = join(workspaceRoot, 'projects/demo/V001');
  await mkdir(join(projectRoot, 'brief'), { recursive: true });
  await mkdir(join(projectRoot, 'requests'));
  const manifest = createProjectManifest({ clientId: 'demo', videoNumber: 1, title: 'test', createdAt: new Date().toISOString(), storage: {
    mode: 'standard', project_root: 'projects/demo/V001', jobs_root: 'artifacts/demo/V001/jobs',
    audio_root: 'artifacts/demo/V001/audio', masters_root: 'artifacts/demo/V001/masters',
  }});
  await json(join(projectRoot, 'project.json'), manifest);
  const continuity = normalizeContinuity({ project_id: manifest.project_id });
  const plan = normalizeShotPlan({ project_id: manifest.project_id,
    source_script: { path: 'brief/source.md', sha256: 'fixture' },
    target: { duration_seconds_total: 4, aspect_ratio: '16:9', model_default: 'gemini-browser' },
    beats: [{ beat_id: 'B01', label: 'test', importance: 'required' }],
    shots: [{ shot_id: 'S001', beat_ids: ['B01'], edit_purpose: 'test', duration_seconds: 4,
      shot_size: 'wide', subject: [], events: [{ event_id: 'E1', text: 'Water flows over stones' }],
      route: { model: 'gemini-browser', mode: 'text_to_video' } }],
  });
  const frozen = { ...plan, status: 'frozen', plan_hash: shotPlanHash(plan), continuity_hash: continuityHash(continuity) };
  await json(join(projectRoot, 'brief/shotplan.json'), frozen);
  await json(join(projectRoot, 'brief/continuity.json'), continuity);
  await composeShotRequests({ projectRoot, workspaceRoot, takeId: 'B1' });
  const requestPath = join(projectRoot, 'requests/S001-B1.json');
  const receiptPath = join(projectRoot, 'requests/S001-B1-completed.json');
  const receipt = { status: 'completed', request_sha256: await hashFile(requestPath), profile: 'test',
    model_label: 'not_exposed', result_url: 'https://gemini.google.com/app/test', submitted_at: '2026-10-18T00:00:00Z',
    completed_at: '2026-10-18T00:01:00Z', cost_note: 'unknown', authorization_note: 'fixture only', settings_note: '16:9' };
  await json(receiptPath, receipt);
  const filePath = join(workspaceRoot, 'download.mp4');
  await writeFile(filePath, 'mock video');
  return { workspaceRoot, projectRoot, requestPath, receiptPath, filePath, plan, continuity, receipt };
}
const media = { probeMedia: async () => ({ duration_seconds: 4, video: { width: 1920, height: 1080 } }) };

test('browser route composes without exposing it as an API model; warns about UI preflight', async () => {
  const f = await fixture();
  const req = JSON.parse(await readFile(f.requestPath));
  assert.equal(req.schema_version, 'browser-request/1');
  assert.equal(req.generate_audio, false);
  assert.throws(() => normalizeVideoRequest(req));
  const checked = shotPlanFindings({ plan: f.plan, continuity: f.continuity });
  assert.ok(checked.findings.some(x => x.code === 'browser_preflight_required'));
  assert.ok(!checked.findings.some(x => x.code === 'route_unbuildable'));
});

test('import preserves originals and hashes, requires review, refuses duplicate version', async () => {
  const f = await fixture();
  const result = await importBrowserTake(f, media);
  assert.equal(result.status, 'review_required');
  assert.equal(result.source_sha256, await hashFile(result.output));
  assert.equal(await readFile(f.filePath, 'utf8'), 'mock video');
  await assert.rejects(importBrowserTake(f, media), /version must increase/);
});

test('import refuses changed prompt even when receipt hash is updated', async () => {
  const f = await fixture();
  const request = JSON.parse(await readFile(f.requestPath));
  request.prompt = 'Different story';
  await json(f.requestPath, request);
  await json(f.receiptPath, { ...f.receipt, request_sha256: await hashFile(f.requestPath) });
  await assert.rejects(importBrowserTake(f, media), /differs from the frozen shot/);
});

test('import refuses mismatched receipt, nonvideo and tampered frozen plan', async () => {
  const f = await fixture();
  await json(f.receiptPath, { ...f.receipt, request_sha256: 'wrong' });
  await assert.rejects(importBrowserTake(f, media), /Receipt request hash mismatch/);
  await json(f.receiptPath, f.receipt);
  await assert.rejects(importBrowserTake(f, { probeMedia: async () => ({ duration_seconds: 4 }) }), /no usable video/);
  const path = join(f.projectRoot, 'brief/shotplan.json');
  const plan = JSON.parse(await readFile(path));
  plan.shots[0].events[0].text = 'Changed';
  await json(path, plan);
  await assert.rejects(importBrowserTake(f, media), /unchanged frozen/);
});
