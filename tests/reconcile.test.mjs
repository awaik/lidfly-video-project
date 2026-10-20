import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRetry } from "../src/workflows/retry.mjs";
import { reconcileVideoJob } from "../src/workflows/reconcile.mjs";
import { planVideoJob, submitVideoJob } from "../src/workflows/video-job.mjs";

const submittedAt = "2026-08-16T20:50:44.652Z";
const submittedMs = Date.parse(submittedAt);

function rawRequest({ takeId = "T001", durationSeconds = 4 } = {}) {
  return {
    schema_version: 1,
    shot_id: "S002",
    take_id: takeId,
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "A rusted grating under a heavy paw",
    duration_seconds: durationSeconds,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
    references: [],
    options: {},
  };
}

/** A job left exactly as a network failure during submit leaves it. */
async function ambiguousJob({ phase = "submission_unknown" } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-reconcile-"));
  const jobsRoot = join(workspaceRoot, "artifacts", "jobs");
  await mkdir(jobsRoot, { recursive: true });
  const source = join(workspaceRoot, "request.json");
  const raw = rawRequest();
  await writeFile(source, JSON.stringify(raw), "utf8");
  const planned = await planVideoJob(raw, { requestSource: source, jobsRoot });

  const statePath = join(planned.jobDirectory, "job.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        phase,
        paid_execution_started: true,
        submission_started_at: submittedAt,
        provider_error: { name: "TypeError", message: "fetch failed", code: null, status: null },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { workspaceRoot, jobsRoot, jobDirectory: planned.jobDirectory, source };
}

function listingClient(tasks, { taskDetails = {} } = {}) {
  const calls = [];
  return {
    calls,
    async listTasks({ limit }) {
      calls.push({ listTasks: limit });
      return { limit, count: tasks.length, tasks };
    },
    async getTask(id) {
      calls.push({ getTask: id });
      return taskDetails[id] ?? {};
    },
    async submitVideo() {
      throw new Error("reconcile must never submit anything");
    },
  };
}

function task(id, { offsetSeconds = 5, model = "seedance-2.5-text-to-video", status = "processing" } = {}) {
  return {
    id,
    model,
    status,
    progress: 40,
    type: "video",
    created_at_ms: submittedMs + offsetSeconds * 1_000,
  };
}

test("a single matching task is reported but never bound without --adopt", async () => {
  const { jobDirectory } = await ambiguousJob();
  const client = listingClient([task("task-unified-1")]);

  const result = await reconcileVideoJob(jobDirectory, { client });
  assert.equal(result.status, "candidate_found");
  assert.equal(result.candidate.id, "task-unified-1");

  const state = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  assert.equal(state.remote_task_id, null);
  assert.equal(state.phase, "submission_unknown");
});

test("--adopt binds the task so the normal wait can finish the job", async () => {
  const { jobDirectory } = await ambiguousJob();
  const client = listingClient([task("task-unified-1")]);

  const result = await reconcileVideoJob(jobDirectory, { client, adopt: true });
  assert.equal(result.status, "adopted");

  const state = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  assert.equal(state.remote_task_id, "task-unified-1");
  assert.equal(state.phase, "processing");
  assert.equal(state.reconciled.outcome, "adopted");
});

test("two candidates are never resolved automatically", async () => {
  const { jobDirectory } = await ambiguousJob();
  const client = listingClient([task("task-a", { offsetSeconds: 3 }), task("task-b", { offsetSeconds: 9 })], {
    // Both were asked for the same duration, so the second discriminator cannot split them.
    taskDetails: { "task-a": { task_info: { video_duration: 4 } }, "task-b": { task_info: { video_duration: 4 } } },
  });

  const result = await reconcileVideoJob(jobDirectory, { client, adopt: true });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  const state = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  assert.equal(state.remote_task_id, null);
});

test("a candidate whose duration does not match the request is discarded", async () => {
  const { jobDirectory } = await ambiguousJob();
  const client = listingClient([task("task-a", { offsetSeconds: 3 }), task("task-b", { offsetSeconds: 9 })], {
    taskDetails: {
      "task-a": { task_info: { video_duration: 10 } },
      "task-b": { task_info: { video_duration: 4 } },
    },
  });

  const result = await reconcileVideoJob(jobDirectory, { client });
  assert.equal(result.status, "candidate_found");
  assert.equal(result.candidate.id, "task-b");
});

test("a task already owned by another job is not a candidate", async () => {
  const { jobsRoot, jobDirectory } = await ambiguousJob();
  // A neighbouring job already holds this task id.
  const neighbour = join(jobsRoot, "S001", "T001-aaaaaaaaaaaa");
  await mkdir(neighbour, { recursive: true });
  await writeFile(
    join(neighbour, "job.json"),
    `${JSON.stringify({ schema_version: 1, phase: "completed", remote_task_id: "task-unified-1" }, null, 2)}\n`,
    "utf8",
  );

  const result = await reconcileVideoJob(jobDirectory, { client: listingClient([task("task-unified-1")]) });
  assert.equal(result.status, "no_candidate");
  assert.equal(result.candidates.length, 0);
});

test("a task outside the submission window is not a candidate", async () => {
  const { jobDirectory } = await ambiguousJob();
  const client = listingClient([task("task-old", { offsetSeconds: -600 })]);
  const result = await reconcileVideoJob(jobDirectory, { client });
  assert.equal(result.status, "no_candidate");
});

test("a truncated listing refuses to conclude that nothing was created", async () => {
  const { jobDirectory } = await ambiguousJob();
  // The page is full and its oldest entry is still newer than the window start.
  const tasks = Array.from({ length: 5 }, (_value, index) =>
    task(`task-${index}`, { offsetSeconds: 600 + index * 10, model: "kling-v3-text-to-video" }),
  );
  const client = listingClient(tasks);

  const result = await reconcileVideoJob(jobDirectory, { client, limit: 5, release: true });
  assert.equal(result.status, "inconclusive_truncated");
  const state = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  assert.equal(state.phase, "submission_unknown");
});

test("--release marks a job that created nothing and opens retry", async () => {
  const { jobDirectory, source } = await ambiguousJob();
  const client = listingClient([]);

  const result = await reconcileVideoJob(jobDirectory, { client, release: true });
  assert.equal(result.status, "released");

  const state = JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"));
  assert.equal(state.phase, "submission_lost");
  // The paid flag stays true: this job may never be submitted again.
  assert.equal(state.paid_execution_started, true);

  await assert.rejects(
    submitVideoJob(jobDirectory, { execute: true, client }),
    /reconciled as lost; create the next take with retry/,
  );

  const retry = await prepareRetry(jobDirectory, { change: "повтор после обрыва сети" });
  assert.equal(retry.take_id, "T002");
  assert.notEqual(retry.retry_request_path, source);
});

test("reconcile refuses a job whose outcome was never ambiguous", async () => {
  const { jobDirectory } = await ambiguousJob({ phase: "planned" });
  await assert.rejects(
    reconcileVideoJob(jobDirectory, { client: listingClient([]) }),
    /reconcile is for a job whose submission outcome is ambiguous/,
  );
});

test("a job that already has a task is left alone", async () => {
  const { jobDirectory } = await ambiguousJob();
  await reconcileVideoJob(jobDirectory, { client: listingClient([task("task-x")]), adopt: true });
  const again = await reconcileVideoJob(jobDirectory, { client: listingClient([task("task-x")]) });
  assert.equal(again.status, "already_bound");
});
