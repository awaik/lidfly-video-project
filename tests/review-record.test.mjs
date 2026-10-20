import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeEditManifest } from "../src/domain/edit-manifest.mjs";
import { normalizeReviewRecord } from "../src/domain/review-record.mjs";
import { assembleMaster } from "../src/workflows/assembly.mjs";

function stubTools() {
  const commands = [];
  return {
    commands,
    tools: {
      async runFfmpeg(args) {
        commands.push(args.join(" "));
        await writeFile(args.at(-1), "stub", "utf8");
      },
      async probeMedia() {
        return {
          duration_seconds: 4,
          video: { codec: "h264", width: 720, height: 1280, frame_rate: 24, pix_fmt: "yuv420p" },
          audio: { codec: "aac", sample_rate: 48_000, channels: 2 },
        };
      },
      async countFrames() {
        return 96;
      },
      async measureLoudness() {
        return { integrated_lufs: -17, true_peak_dbtp: -1.5, lra: 3 };
      },
      async measureWindow(_path, window) {
        return { ...window, mean_db: -18, max_db: -2 };
      },
      async detectBlackAndFreeze() {
        return { black: [], freeze: [] };
      },
    },
  };
}

async function workspace(segment, { review } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-review-gate-"));
  await writeFile(join(directory, "shot.mp4"), "stub:shot", "utf8");
  if (review) {
    await writeFile(join(directory, "take.review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
  }
  const manifest = {
    variant_id: "B1",
    output: { masters_root: "masters" },
    segments: [{ id: "hook", kind: "clip", source: "shot.mp4", frames: 96, audio: "silent", ...segment }],
  };
  const manifestPath = join(directory, "edit.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { directory, manifestPath };
}

test("both review shapes found in real manifests are understood", () => {
  const manifest = normalizeEditManifest({
    variant_id: "B1",
    output: { masters_root: "masters" },
    segments: [
      { id: "a", kind: "clip", source: "a.mp4", frames: 24, review: "projects/x/reviews/S001-T001.review.json" },
      { id: "b", kind: "clip", source: "b.mp4", frames: 24, review: "review-round2-b2#S101/T001 accept" },
    ],
  });
  assert.equal(manifest.segments[0].review.kind, "path");
  assert.equal(manifest.segments[1].review.kind, "note");
});

test("a rejecting decision is a blocker, whatever else the record says", () => {
  const record = normalizeReviewRecord({ decision: "regenerate", shot_id: "S001" });
  assert.equal(record.accepts, false);
  assert.equal(normalizeReviewRecord({ decision: "accept_with_trim" }).accepts, true);
  assert.throws(() => normalizeReviewRecord({ decision: "maybe" }), /decision must be one of/);
});

test("hard gates are read from both recorded shapes", () => {
  const flat = normalizeReviewRecord({
    decision: "accept",
    hard_gates: { policy_or_rights_conflict: false, corrupt_media: true, dialogue: "not_applicable" },
  });
  assert.deepEqual(flat.hard_gates_failed, ["corrupt_media"]);

  const rubric = normalizeReviewRecord({
    decision: "accept",
    hard_gates: { passed: false, failures: ["identity"] },
  });
  assert.deepEqual(rubric.hard_gates_failed, ["identity"]);
});

test("an unknown field in a review record is tolerated, because humans write these", () => {
  const record = normalizeReviewRecord({ decision: "accept", nastroenie: "ок", reviewer: "producer" });
  assert.equal(record.accepts, true);
  assert.equal(record.reviewer, "producer");
});

test("a timeline built on a rejected take never reaches an ok report", async () => {
  const { directory, manifestPath } = await workspace(
    { review: "take.review.json" },
    { review: { decision: "regenerate", shot_id: "S001", take_id: "T001" } },
  );
  const report = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.equal(report.verification.status, "review_required");
  assert.ok(report.verification.issues.some((issue) => issue.startsWith("review_rejected")));
  assert.equal(report.reviews[0].decision, "regenerate");
});

test("a review path that does not resolve is a blocker, not a shrug", async () => {
  const { directory, manifestPath } = await workspace({ review: "reviews/missing.review.json" });
  const report = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.ok(report.verification.issues.some((issue) => issue.startsWith("review_unreadable")));
});

test("a missing or free-text review only warns, so existing projects still build", async () => {
  const plain = await workspace({});
  const report = await assembleMaster(plain.manifestPath, {
    workspaceRoot: plain.directory,
    tools: stubTools().tools,
  });
  assert.equal(report.verification.status, "ok");
  assert.ok(report.verification.warnings.some((warning) => warning.startsWith("review_missing")));

  const note = await workspace({ review: "review-round2#S101 accept" });
  const noteReport = await assembleMaster(note.manifestPath, {
    workspaceRoot: note.directory,
    tools: stubTools().tools,
  });
  assert.equal(noteReport.verification.status, "ok");
  assert.ok(
    noteReport.verification.warnings.some((warning) => warning.startsWith("review_not_machine_readable")),
  );
});

test("--require-review promotes the soft findings to blockers", async () => {
  const { directory, manifestPath } = await workspace({});
  const report = await assembleMaster(manifestPath, {
    workspaceRoot: directory,
    tools: stubTools().tools,
    requireReview: true,
  });
  assert.equal(report.verification.status, "review_required");
  assert.ok(report.verification.issues.some((issue) => issue.startsWith("review_missing")));
});

test("a cut that runs past the reviewed range is reported", async () => {
  const { directory, manifestPath } = await workspace(
    { review: "take.review.json", frames: 96 },
    {
      review: {
        decision: "accept_with_trim",
        source_sha256: "unrelated",
        usable_range_seconds: [0, 2],
      },
    },
  );
  const report = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.ok(report.verification.warnings.some((warning) => warning.startsWith("review_range_exceeded")));
  // The hash recorded at review time no longer matches the file being cut.
  assert.ok(report.verification.warnings.some((warning) => warning.startsWith("review_source_mismatch")));
  assert.equal(report.reviews[0].source_matches_review, false);
});

test("an overlay that declares a collision with the subject blocks the master", async () => {
  const { directory, manifestPath } = await workspace({
    overlays: [
      {
        asset: "shot.mp4",
        x: 0,
        y: 1400,
        from_seconds: 0,
        to_seconds: 2,
        subject_checked_at_seconds: [0, 1, 2],
        subject_clear: false,
      },
    ],
  });
  const report = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.ok(report.verification.issues.some((issue) => issue.startsWith("overlay_subject_collision")));
  assert.equal(report.overlay_clearance[0].subject_clear, false);
});

test("a long overlay checked at a single moment is flagged as sparse", async () => {
  const { directory, manifestPath } = await workspace({
    overlays: [
      {
        asset: "shot.mp4",
        x: 0,
        y: 300,
        from_seconds: 0,
        to_seconds: 3,
        subject_checked_at_seconds: [0],
        subject_clear: true,
      },
    ],
  });
  const report = await assembleMaster(manifestPath, { workspaceRoot: directory, tools: stubTools().tools });
  assert.ok(report.verification.warnings.some((warning) => warning.startsWith("overlay_clearance_sparse")));
});

test("checked timestamps must sit inside the overlay window", () => {
  assert.throws(
    () =>
      normalizeEditManifest({
        variant_id: "B1",
        output: { masters_root: "masters" },
        segments: [
          {
            id: "a",
            kind: "clip",
            source: "a.mp4",
            frames: 96,
            overlays: [
              { asset: "t.png", from_seconds: 1, to_seconds: 2, subject_checked_at_seconds: [1, 5] },
            ],
          },
        ],
      }),
    /must fall inside the overlay window/,
  );
});
