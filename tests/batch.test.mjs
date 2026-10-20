import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planRequestDirectory, waitForJobsRoot } from "../src/workflows/batch.mjs";
import { planVideoJob } from "../src/workflows/video-job.mjs";

function request({ shotId = "S001", takeId = "T001", durationSeconds = 4 } = {}) {
  return {
    schema_version: 1,
    shot_id: shotId,
    take_id: takeId,
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "A stable vertical shot",
    duration_seconds: durationSeconds,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: false,
    references: [],
    options: {},
  };
}

async function requestsDirectory(files) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-batch-"));
  const requestsRoot = join(workspaceRoot, "requests");
  await mkdir(requestsRoot, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(requestsRoot, name), typeof body === "string" ? body : JSON.stringify(body), "utf8");
  }
  return { workspaceRoot, requestsRoot, jobsRoot: join(workspaceRoot, "artifacts", "jobs") };
}

test("planning a directory prices the whole batch before anything is paid", async () => {
  const { requestsRoot, jobsRoot } = await requestsDirectory({
    "S001-T001.json": request({ shotId: "S001" }),
    "S002-T001.json": request({ shotId: "S002", durationSeconds: 5 }),
    ".hidden.json": request({ shotId: "S003" }),
    "notes.txt": "not a request",
  });

  const report = await planRequestDirectory(requestsRoot, { jobsRoot });
  assert.equal(report.count, 2, "only visible .json files are planned");
  assert.equal(report.planned, 2);
  assert.equal(report.failed, 0);
  // 4 s + 5 s of Seedance 2.5 at 720p.
  assert.equal(report.total_estimated_usd, 2.662);
});

test("re-planning the same directory reuses the jobs instead of duplicating them", async () => {
  const { requestsRoot, jobsRoot } = await requestsDirectory({ "S001-T001.json": request() });
  const first = await planRequestDirectory(requestsRoot, { jobsRoot });
  const second = await planRequestDirectory(requestsRoot, { jobsRoot });

  assert.equal(first.planned, 1);
  assert.equal(second.reused, 1);
  assert.equal(second.planned, 0);
  assert.equal(first.results[0].job_directory, second.results[0].job_directory);
});

test("one broken request does not stop the rest of the batch", async () => {
  const { requestsRoot, jobsRoot } = await requestsDirectory({
    "S001-T001.json": request({ shotId: "S001" }),
    "S002-T001.json": "{ not json",
    "S003-T001.json": request({ shotId: "S003", durationSeconds: 2 }),
  });

  const report = await planRequestDirectory(requestsRoot, { jobsRoot });
  assert.equal(report.planned, 1);
  assert.equal(report.failed, 2);
  assert.match(report.results.find((item) => item.request_path.endsWith("S003-T001.json")).error, /duration_seconds/);
});

test("waiting on a jobs root skips what is already finished", async () => {
  const { workspaceRoot, jobsRoot } = await requestsDirectory({});
  const source = join(workspaceRoot, "request.json");
  await writeFile(source, JSON.stringify(request()), "utf8");
  const pending = await planVideoJob(request(), { requestSource: source, jobsRoot });

  // Give it a task id so it counts as in-flight, and add a finished neighbour.
  const statePath = join(pending.jobDirectory, "job.json");
  const state = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(statePath, "utf8")));
  await writeFile(
    statePath,
    `${JSON.stringify({ ...state, phase: "processing", remote_task_id: "task-pending" }, null, 2)}\n`,
    "utf8",
  );
  const done = join(jobsRoot, "S009", "T001-abcabcabcabc");
  await mkdir(done, { recursive: true });
  await writeFile(
    join(done, "job.json"),
    `${JSON.stringify({ schema_version: 1, phase: "completed", remote_task_id: "task-done" }, null, 2)}\n`,
    "utf8",
  );

  const waited = [];
  const client = {
    async waitForTask(taskId, { onUpdate }) {
      waited.push(taskId);
      await onUpdate({ id: taskId, status: "completed", progress: 100 });
      return { id: taskId, status: "completed", progress: 100, results: [] };
    },
  };

  const report = await waitForJobsRoot(jobsRoot, { client, download: false });
  assert.deepEqual(waited, ["task-pending"], "the finished job is not polled again");
  assert.equal(report.waited, 1);
  assert.equal(report.completed, 1);
});
