import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashFile } from "../src/core/hashing.mjs";
import { adoptExternalMaster, deriveCutList, verifyAdoptedMaster } from "../src/workflows/adopt-master.mjs";

/**
 * Measurement stubs: the adoption decisions are about versioning, provenance and
 * the comparison with the plan, not about decoding video in a unit test.
 */
function stubTools({
  width = 1080,
  height = 1920,
  frameRate = 24,
  duration = 8,
  frames = 192,
  loudness = { integrated_lufs: -17, true_peak_dbtp: -1.5, lra: 3, threshold: -27 },
  black = [],
  freeze = [],
  audio = { codec: "aac", sample_rate: 48_000, channels: 2 },
} = {}) {
  const calls = [];
  return {
    calls,
    tools: {
      async probeMedia(path) {
        calls.push(["probe", path]);
        return {
          duration_seconds: duration,
          video: { codec: "h264", width, height, frame_rate: frameRate, pix_fmt: "yuv420p" },
          audio,
        };
      },
      async countFrames() {
        return frames;
      },
      async measureLoudness() {
        calls.push(["loudness"]);
        return loudness;
      },
      async detectBlackAndFreeze() {
        return { black, freeze };
      },
    },
  };
}

/** A project the way init-production lays it out, with an optional frozen plan. */
async function workspace({ plan = { aspect_ratio: "9:16", frame_rate: 24, duration_seconds_total: 8, duration_tolerance_seconds: 0.5 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lidfly-adopt-"));
  const projectRoot = "projects/acme/V001";
  await mkdir(join(root, projectRoot, "brief"), { recursive: true });
  await writeFile(
    join(root, projectRoot, "project.json"),
    JSON.stringify({
      schema_version: 1,
      client_id: "acme",
      project_id: "ACME-V001",
      storage: {
        mode: "standard",
        project_root: projectRoot,
        jobs_root: "artifacts/acme/V001/jobs",
        audio_root: "artifacts/acme/V001/audio",
        masters_root: "artifacts/acme/V001/masters",
      },
    }),
  );
  if (plan) {
    await writeFile(join(root, projectRoot, "brief", "shotplan.json"), JSON.stringify({ status: "frozen", target: plan, shots: [] }));
  }
  await mkdir(join(root, "exports"), { recursive: true });
  await writeFile(join(root, "exports", "cut-a.mp4"), "export-a");
  await writeFile(join(root, "exports", "cut-b.mp4"), "export-b");
  return { root, projectRoot, mastersDir: join(root, "artifacts/acme/V001/masters") };
}

function timeline({ fps = 24, items } = {}) {
  return {
    fps,
    tracks: [{ id: "v1", alias: "V1", trackType: "video" }, { id: "a1", alias: "A1", trackType: "audio" }],
    items: items ?? [
      { id: "clip-1", trackId: "v1", kind: "video", name: "S001-T001", startFrame: 0, durationInFrames: 96, sourceAssetId: "asset-1" },
      { id: "clip-2", trackId: "v1", kind: "video", name: "S002-T002", startFrame: 96, durationInFrames: 96, sourceAssetId: "asset-2" },
      { id: "music", trackId: "a1", kind: "audio", name: "bed", startFrame: 0, durationInFrames: 192, sourceAssetId: "asset-3" },
    ],
  };
}

test("a cut list follows the busiest visual track, in order, with gaps kept as segments", () => {
  const result = deriveCutList(
    timeline({
      items: [
        { id: "title", trackId: "v2", kind: "text", startFrame: 0, durationInFrames: 40 },
        { id: "b", trackId: "v1", kind: "video", startFrame: 120, durationInFrames: 72, sourceAssetId: "asset-2" },
        { id: "a", trackId: "v1", kind: "video", startFrame: 0, durationInFrames: 96, sourceAssetId: "asset-1" },
        { id: "logo", trackId: "v2", kind: "image", startFrame: 150, durationInFrames: 42 },
        { id: "bed", trackId: "a1", kind: "audio", startFrame: 0, durationInFrames: 192 },
      ],
    }),
  );
  assert.equal(result.base_track, "v1");
  assert.deepEqual(result.segments.map((segment) => [segment.id, segment.frames]), [
    ["a", 96],
    ["gap-96", 24],
    ["b", 72],
  ]);
  assert.equal(result.total_frames, 192);
  assert.deepEqual(result.warnings, []);
});

test("overlapping clips stop the cut list with a warning instead of a wrong timeline", () => {
  const result = deriveCutList(
    timeline({
      items: [
        { id: "a", trackId: "v1", kind: "video", startFrame: 0, durationInFrames: 96 },
        { id: "b", trackId: "v1", kind: "video", startFrame: 80, durationInFrames: 96 },
      ],
    }),
  );
  assert.deepEqual(result.segments.map((segment) => segment.id), ["a"]);
  assert.match(result.warnings[0], /overlapping items/);
  assert.deepEqual(deriveCutList({}).segments, []);
  assert.match(deriveCutList({ fps: 24, items: [] }).warnings[0], /no visual items/);
});

test("an export is adopted as v1 with its sha256, origin and measured verification", async () => {
  const { root, projectRoot, mastersDir } = await workspace();
  const timelinePath = join(root, "exports", "timeline.json");
  await writeFile(timelinePath, JSON.stringify(timeline()));
  const { tools, calls } = stubTools();

  const report = await adoptExternalMaster({
    workspaceRoot: root,
    projectRoot,
    variantId: "E002",
    sourcePath: "exports/cut-a.mp4",
    timelinePath,
    rendererProjectId: "occ-project-1",
    renderId: "render-9",
    note: "first OpenChatCut cut",
    tools,
    now: () => new Date("2026-09-05T12:00:00.000Z"),
  });

  assert.equal(report.schema, "adopted-master/1");
  assert.equal(report.version, "v1");
  assert.equal(report.project_id, "ACME-V001");
  assert.equal(report.master_path, join(mastersDir, "E002", "E002-master-v1.mp4"));
  assert.equal(report.master_sha256, await hashFile(join(root, "exports", "cut-a.mp4")));
  assert.equal(await readFile(report.master_path, "utf8"), "export-a");
  assert.equal(await readFile(join(root, "exports", "cut-a.mp4"), "utf8"), "export-a", "the source is copied, never moved");
  assert.deepEqual(
    { ...report.origin },
    {
      renderer: "openchatcut",
      renderer_project_id: "occ-project-1",
      render_id: "render-9",
      source_path: join(root, "exports", "cut-a.mp4"),
      source_sha256: report.master_sha256,
      note: "first OpenChatCut cut",
      adopted_at: "2026-09-05T12:00:00.000Z",
    },
  );
  assert.equal(report.review_binding, "unbound");
  assert.equal(report.plan_checked, true);
  assert.equal(report.verification.status, "ok");
  assert.deepEqual(report.verification.plan_checks.aspect_ratio, { plan: "9:16", master: "9:16" });
  assert.equal(report.verification.loudness.integrated_lufs, -17);
  assert.deepEqual(report.cut_list.segments.map((segment) => segment.id), ["clip-1", "clip-2"]);
  assert.ok(calls.some(([name]) => name === "loudness"));

  const files = (await readdir(join(mastersDir, "E002"))).sort();
  assert.deepEqual(files, [
    "E002-master-v1.cutlist.json",
    "E002-master-v1.mp4",
    "E002-master-v1.report.json",
    "E002-master-v1.timeline.json",
  ]);
  const cutList = JSON.parse(await readFile(join(mastersDir, "E002", "E002-master-v1.cutlist.json"), "utf8"));
  assert.equal(cutList.output.frame_rate, 24);
  assert.deepEqual(cutList.segments.map((segment) => segment.frames), [96, 96]);
  const stored = JSON.parse(await readFile(join(mastersDir, "E002", "E002-master-v1.report.json"), "utf8"));
  assert.equal(stored.master_sha256, report.master_sha256);
});

test("adopting the same bytes again returns the existing version; new bytes get the next one", async () => {
  const { root, projectRoot, mastersDir } = await workspace();
  const { tools } = stubTools();
  // A master the manifest assembler already built occupies v1.
  await mkdir(join(mastersDir, "E001"), { recursive: true });
  await writeFile(join(mastersDir, "E001", "E001-master-v1.mp4"), "assembled");

  const first = await adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E001", sourcePath: "exports/cut-a.mp4", tools });
  assert.equal(first.version, "v2");
  const again = await adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E001", sourcePath: "exports/cut-a.mp4", tools });
  assert.equal(again.reused, true);
  assert.equal(again.version, "v2");
  const third = await adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E001", sourcePath: "exports/cut-b.mp4", tools });
  assert.equal(third.version, "v3");
  assert.equal(await readFile(join(mastersDir, "E001", "E001-master-v1.mp4"), "utf8"), "assembled", "earlier masters stay untouched");
});

test("a master that disagrees with the frozen plan or the timeline is review_required, with the numbers", async () => {
  const { root, projectRoot } = await workspace();
  const timelinePath = join(root, "exports", "timeline.json");
  await writeFile(timelinePath, JSON.stringify(timeline()));
  const { tools } = stubTools({ width: 1920, height: 1080, frameRate: 30, duration: 10, frames: 300, loudness: { integrated_lufs: -23, true_peak_dbtp: -0.2 } });

  const report = await adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E003", sourcePath: "exports/cut-a.mp4", timelinePath, tools });
  assert.equal(report.verification.status, "review_required");
  const issues = report.verification.issues.join("\n");
  assert.match(issues, /master_aspect_ratio_off_plan: plan 9:16, master 16:9 \(1920x1080\)/);
  assert.match(issues, /master_frame_rate_off_plan: plan 24 fps, master 30 fps/);
  assert.match(issues, /master_duration_off_plan: plan 8s ±0.5s, master 10s/);
  assert.match(issues, /frame count is 300, timeline snapshot declares 192/);
  assert.match(issues, /-23 LUFS is outside the declared target -20\.\.-16/);
  assert.match(issues, /true peak -0.2 dBTP/);
});

test("without a frozen plan only the file itself is measured, and frozen stretches are a warning", async () => {
  const { root, projectRoot } = await workspace({ plan: null });
  const { tools } = stubTools({ freeze: [{ start: 2.5 }], audio: null });
  const report = await adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E004", sourcePath: "exports/cut-a.mp4", tools, targetLufs: "-18,-14" });
  assert.equal(report.plan_checked, false);
  assert.equal(report.verification.plan_checks, null);
  assert.deepEqual(report.verification.target_lufs, [-18, -14]);
  assert.deepEqual(report.verification.issues, ["master has no audio stream"]);
  assert.match(report.verification.warnings[0], /frozen stretches at 2.5s/);
});

test("a download URL is accepted only from the local editor and the file is fetched once", async () => {
  const { root, projectRoot, mastersDir } = await workspace();
  const { tools } = stubTools();
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    return new Response("downloaded-master", { status: 200 });
  };

  const report = await adoptExternalMaster({
    workspaceRoot: root,
    projectRoot,
    variantId: "E005",
    sourceUrl: "http://localhost:5199/media/uploads/render-1.mp4",
    tools,
    fetchImpl,
  });
  assert.deepEqual(fetched, ["http://localhost:5199/media/uploads/render-1.mp4"]);
  assert.equal(report.origin.source_url, "http://localhost:5199/media/uploads/render-1.mp4");
  assert.equal(await readFile(report.master_path, "utf8"), "downloaded-master");
  const leftovers = (await readdir(join(mastersDir, "E005"))).filter((name) => name.startsWith(".incoming"));
  assert.deepEqual(leftovers, []);

  await assert.rejects(
    adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E006", sourceUrl: "https://cdn.example.com/master.mp4", tools, fetchImpl }),
    /local editor/,
  );
  await assert.rejects(
    adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E006", sourcePath: "exports/cut-a.mp4", sourceUrl: "http://localhost:5199/x.mp4", tools }),
    /exactly one of --file or --url/,
  );
  await assert.rejects(
    adoptExternalMaster({ workspaceRoot: root, projectRoot, variantId: "E006", sourcePath: "exports/missing.mp4", tools }),
    /source master not found/,
  );
});

test("verification works on its own against an explicit plan", async () => {
  const { tools } = stubTools({ duration: 9.2 });
  const result = await verifyAdoptedMaster("/tmp/unused.mp4", {
    tools,
    plan: { status: "frozen", target: { aspect_ratio: "adaptive", frame_rate: 24, duration_seconds_total: 8 } },
  });
  assert.deepEqual(result.issues, ["master_duration_off_plan: plan 8s ±1s, master 9.2s"]);
  assert.equal(result.plan_checks.duration_seconds.tolerance, 1);
});
