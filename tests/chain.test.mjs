import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractJobFrames, prepareChainedRequest } from "../src/workflows/chain.mjs";
import { planVideoJob } from "../src/workflows/video-job.mjs";

function request() {
  return {
    schema_version: 1,
    shot_id: "S004",
    take_id: "T001",
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "The backpack falls toward the black water",
    duration_seconds: 4,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
    references: [],
    options: {},
  };
}

/** A finished job with a downloaded take, as wait leaves it. */
async function completedJob({ phase = "completed", withFrames = true } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-chain-"));
  const jobsRoot = join(workspaceRoot, "artifacts", "jobs");
  await mkdir(jobsRoot, { recursive: true });
  const source = join(workspaceRoot, "request.json");
  await writeFile(source, JSON.stringify(request()), "utf8");
  const planned = await planVideoJob(request(), { requestSource: source, jobsRoot });

  const outputsRoot = join(planned.jobDirectory, "outputs");
  await mkdir(outputsRoot, { recursive: true });
  const output = join(outputsRoot, "result-01.mp4");
  await writeFile(output, "stub video", "utf8");
  const lastFrame = join(outputsRoot, "result-01-last.png");
  if (withFrames) await writeFile(lastFrame, "stub frame", "utf8");

  const statePath = join(planned.jobDirectory, "job.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        phase,
        remote_task_id: "task-done",
        outputs: [output],
        ...(withFrames ? { frames: [{ output, last_frame: lastFrame, first_frame: lastFrame }] } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { workspaceRoot, jobDirectory: planned.jobDirectory, output, lastFrame };
}

async function reviewFile(workspaceRoot, decision) {
  const path = join(workspaceRoot, "review.json");
  await writeFile(
    path,
    `${JSON.stringify({ shot_id: "S004", take_id: "T001", decision }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

test("a chained request starts from the last frame and records where it came from", async () => {
  const job = await completedJob();
  const review = await reviewFile(job.workspaceRoot, "accept");
  const target = join(job.workspaceRoot, "S005-T001.json");

  const result = await prepareChainedRequest({
    fromJobDirectory: job.jobDirectory,
    requestPath: target,
    reviewPath: review,
  });
  assert.equal(result.frame_path, job.lastFrame);

  const written = JSON.parse(await readFile(target, "utf8"));
  assert.equal(written.mode, "image_to_video");
  assert.equal(written.references[0].role, "start_frame");
  assert.equal(written.references[0].path, job.lastFrame);
  assert.equal(written.metadata.continuity.from_shot_id, "S004");
  assert.match(written.metadata.continuity.frame_sha256, /^[a-f0-9]{64}$/);
  // The caution about accumulating drift travels with the command.
  assert.match(result.caution, /720px/);
});

test("chaining from a take nobody accepted is refused", async () => {
  const job = await completedJob();
  const review = await reviewFile(job.workspaceRoot, "regenerate");
  await assert.rejects(
    prepareChainedRequest({
      fromJobDirectory: job.jobDirectory,
      requestPath: join(job.workspaceRoot, "next.json"),
      reviewPath: review,
    }),
    /was not accepted \(decision "regenerate"\)/,
  );
});

test("chaining without a review is refused outright", async () => {
  const job = await completedJob();
  await assert.rejects(
    prepareChainedRequest({
      fromJobDirectory: job.jobDirectory,
      requestPath: join(job.workspaceRoot, "next.json"),
    }),
    /Chaining requires the review that accepted the source take/,
  );
});

test("chaining from an unfinished job is refused", async () => {
  const job = await completedJob({ phase: "processing" });
  const review = await reviewFile(job.workspaceRoot, "accept");
  await assert.rejects(
    prepareChainedRequest({
      fromJobDirectory: job.jobDirectory,
      requestPath: join(job.workspaceRoot, "next.json"),
      reviewPath: review,
    }),
    /chain from a completed take only/,
  );
});

test("a job downloaded before frames existed gets them extracted on demand", async () => {
  const job = await completedJob({ withFrames: false });
  const extracted = [];
  const result = await extractJobFrames(job.jobDirectory, {
    tools: {
      async extractFrame(video, target, { position }) {
        extracted.push(position);
        await writeFile(target, `stub ${position}`, "utf8");
        return target;
      },
    },
  });
  assert.deepEqual(extracted, ["first", "last"]);
  assert.match(result.frames[0].last_frame, /result-01-last\.png$/);
});

test("a chained request never overwrites an existing file", async () => {
  const job = await completedJob();
  const review = await reviewFile(job.workspaceRoot, "accept");
  const target = join(job.workspaceRoot, "S005-T001.json");
  await writeFile(target, "{}", "utf8");
  await assert.rejects(
    prepareChainedRequest({ fromJobDirectory: job.jobDirectory, requestPath: target, reviewPath: review }),
    /already exists/,
  );
});
