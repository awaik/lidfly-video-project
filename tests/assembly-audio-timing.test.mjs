import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleMaster } from '../src/workflows/assembly.mjs';
import { runFfmpeg, probeMedia, countFrames } from '../src/media/ffmpeg.mjs';
const exec = promisify(execFile);

// A real codec regression: mocked arguments alone cannot reveal encoder delay
// accumulating across an otherwise frame-correct timeline.
test('native audio markers stay aligned across repeated frame-sized cuts', { timeout: 120000 }, async (t) => {
  try { await exec('ffmpeg', ['-version']); await exec('ffprobe', ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('local ffmpeg/ffprobe unavailable'); throw error; }
  const dir = await mkdtemp(join(tmpdir(), 'lidfly-audio-timing-'));
  const source = join(dir, 'pulse.mov');
  await runFfmpeg(['-f','lavfi','-i','testsrc2=size=32x32:rate=30:duration=0.8',
    '-f','lavfi','-i',"aevalsrc=0.35*sin(2*PI*997*t)*between(t\\,0.18\\,0.22):s=48000:d=0.8",
    '-c:v','libx264','-pix_fmt','yuv420p','-c:a','pcm_s16le',source]);
  for (const mixed of [false, true]) {
  const manifest = { variant_id:mixed ? 'MIXED' : 'TIMING', output:{width:32,height:32,frame_rate:30,audio_sample_rate:48000,masters_root:'masters'},
    segments:Array.from({length:10},(_,i)=>({id:`s${i}`,kind:'clip',source:'pulse.mov',frames:16,audio:'source'})) };
  if (mixed) manifest.audio = {};
  const manifestPath = join(dir,mixed ? 'mixed.json' : 'edit.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const report = await assembleMaster(manifestPath,{workspaceRoot:dir,tools:{runFfmpeg,probeMedia,countFrames,
    async detectBlackAndFreeze(){return {black:[],freeze:[]};},
    async measureLoudness(){return {integrated_lufs:-18,true_peak_dbtp:-2};},
    async measureWindow(){return {mean_db:-18,max_db:-2};}}});
  assert.equal(report.verification.frames,160);
  const pcm = join(dir,mixed ? 'mixed.f32' : 'master.f32');
  await runFfmpeg(['-i',report.master_path,'-vn','-ac','1','-ar','48000','-c:a','pcm_f32le','-f','f32le',pcm]);
  const bytes = await readFile(pcm); const values=[];
  for(let i=0;i<bytes.length;i+=4)values.push(bytes.readFloatLE(i));
  const bursts=[]; let active=[]; let last=-Infinity;
  for(let i=0;i<values.length;i++){
    if(Math.abs(values[i])<0.015)continue;
    if(i-last>48000*.06 && active.length){bursts.push(active);active=[];}
    active.push(i);last=i;
  }
  if(active.length)bursts.push(active);
  assert.equal(bursts.length,10,'every cut must preserve its audio marker');
  for(const [i,indices] of bursts.entries()){
    let weighted=0,power=0;
    for(const index of indices){const p=values[index]**2;power+=p;weighted+=index*p;}
    const centre=weighted/power/48000; const expected=i*16/30+.2;
    assert.ok(Math.abs(centre-expected)<.01,`${mixed ? 'mixed' : 'unmixed'} cut ${i}: audio marker ${centre.toFixed(6)}s, expected ${expected.toFixed(6)}s`);
  }
  }
});
