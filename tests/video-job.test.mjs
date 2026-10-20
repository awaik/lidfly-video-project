import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProviderError } from "../src/core/errors.mjs";
import {
  loadVideoJob,
  planVideoJob,
  refreshVideoJob,
  submitVideoJob,
  waitForVideoJob,
} from "../src/workflows/video-job.mjs";

function rawRequest() {
  return {
    schema_version: 1,
    shot_id: "S100",
    take_id: "T001",
    provider: "evolink",
    model: "kling-v3",
    mode: "text_to_video",
    prompt: "A stable vertical shot",
    duration_seconds: 5,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: false,
    references: [],
    options: {},
  };
}

test("planning is deterministic and reuses the same immutable job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-plan-"));
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(rawRequest()), "utf8");
  const first = await planVideoJob(rawRequest(), {
    requestSource: source,
    jobsRoot: join(directory, "jobs"),
  });
  const second = await planVideoJob(rawRequest(), {
    requestSource: source,
    jobsRoot: join(directory, "jobs"),
  });
  assert.equal(first.jobDirectory, second.jobDirectory);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.state.resolved_model_id, "kling-v3-text-to-video");
  assert.equal(first.state.paid_execution_started, false);
});

test("planning without a model resolves Seedance 2.5 and persists the exact route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-default-model-"));
  const request = rawRequest();
  delete request.model;
  const plan = await planVideoJob(request, { jobsRoot: join(directory, "jobs") });

  assert.equal(plan.request.model, "seedance-2.5");
  assert.equal(plan.state.resolved_model_id, "seedance-2.5-text-to-video");
  assert.equal(plan.capabilitySnapshot.requested_label, "Seedance 2.5");
  assert.match(plan.capabilitySnapshot.source, /seedance2\.5\/seedance-2\.5-overview/);
});

test("production planning binds metadata identity to the project-specific jobs root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-production-plan-"));
  const request = {
    ...rawRequest(),
    metadata: {
      production: {
        client_id: "acme",
        project_id: "ACME-V001",
        video_number: 1,
      },
    },
  };
  const jobsRoot = join(directory, "artifacts/acme/V001/jobs");
  const plan = await planVideoJob(request, { jobsRoot });
  assert.match(plan.jobDirectory, /artifacts\/acme\/V001\/jobs\/S100\//);

  await assert.rejects(
    planVideoJob(request, { jobsRoot: join(directory, "artifacts/acme/V002/jobs") }),
    /jobsRoot does not match metadata\.production/,
  );
  await assert.rejects(
    planVideoJob(rawRequest(), { jobsRoot }),
    /metadata\.production is required/,
  );
});

test("paid submission is explicit and cannot submit the same job twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-submit-"));
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(rawRequest()), "utf8");
  const plan = await planVideoJob(rawRequest(), {
    requestSource: source,
    jobsRoot: join(directory, "jobs"),
  });
  let submissions = 0;
  const client = {
    async submitVideo(payload) {
      submissions += 1;
      assert.equal(payload.model, "kling-v3-text-to-video");
      return {
        id: "task-unified-123-safe",
        model: payload.model,
        status: "pending",
        usage: { credits_reserved: 5 },
      };
    },
  };

  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: false, client }),
    /requires explicit execute=true/,
  );
  const first = await submitVideoJob(plan.jobDirectory, { execute: true, client });
  const second = await submitVideoJob(plan.jobDirectory, { execute: true, client });
  assert.equal(first.state.remote_task_id, "task-unified-123-safe");
  assert.equal(second.reused, true);
  assert.equal(submissions, 1);
});

test("submission failures persist rejected and unknown outcomes without resubmitting", async () => {
  for (const scenario of [
    { status: 422, phase: "submission_rejected", retryMessage: /immutable job was rejected/ },
    { status: 503, phase: "submission_unknown", retryMessage: /outcome is ambiguous/ },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `lidfly-${scenario.phase}-`));
    const source = join(directory, "request.json");
    await writeFile(source, JSON.stringify(rawRequest()), "utf8");
    const plan = await planVideoJob(rawRequest(), {
      requestSource: source,
      jobsRoot: join(directory, "jobs"),
    });
    let submissions = 0;
    const client = {
      async submitVideo() {
        submissions += 1;
        throw new ProviderError("provider submission failed", { status: scenario.status });
      },
    };

    await assert.rejects(
      submitVideoJob(plan.jobDirectory, { execute: true, client }),
      /provider submission failed/,
    );
    const failedJob = await loadVideoJob(plan.jobDirectory);
    assert.equal(failedJob.state.phase, scenario.phase);
    assert.equal(failedJob.state.provider_error.status, scenario.status);
    await assert.rejects(
      submitVideoJob(plan.jobDirectory, { execute: true, client }),
      scenario.retryMessage,
    );
    assert.equal(submissions, 1);
  }
});

test("task snapshots remain collision-safe within the same millisecond", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-task-snapshots-"));
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(rawRequest()), "utf8");
  const plan = await planVideoJob(rawRequest(), {
    requestSource: source,
    jobsRoot: join(directory, "jobs"),
  });
  await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo(payload) {
        return { id: "task-collision-safe", model: payload.model, status: "pending" };
      },
    },
  });
  let progress = 0;
  const client = {
    async getTask() {
      progress += 1;
      return { id: "task-collision-safe", status: "processing", progress };
    },
  };
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    await refreshVideoJob(plan.jobDirectory, { client });
    await refreshVideoJob(plan.jobDirectory, { client });
  } finally {
    Date.now = originalNow;
  }
  const snapshots = (await readdir(plan.jobDirectory)).filter((name) => name.startsWith("task-"));
  assert.equal(snapshots.length, 2);
  assert.notEqual(snapshots[0], snapshots[1]);
});

test("wait polling does not persist duplicate state events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-poll-events-"));
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(rawRequest()), "utf8");
  const plan = await planVideoJob(rawRequest(), {
    requestSource: source,
    jobsRoot: join(directory, "jobs"),
  });
  await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo(payload) {
        return { id: "task-poll-dedup", model: payload.model, status: "pending" };
      },
    },
  });
  const eventsDirectory = join(plan.jobDirectory, "events");
  const eventsBefore = (await readdir(eventsDirectory)).length;
  const processing = { id: "task-poll-dedup", status: "processing", progress: 50 };
  const completed = { id: "task-poll-dedup", status: "completed", progress: 100, results: [] };
  const client = {
    async waitForTask(_taskId, { onUpdate }) {
      await onUpdate(processing);
      await onUpdate(processing);
      await onUpdate(processing);
      await onUpdate(completed);
      return completed;
    },
  };
  await waitForVideoJob(plan.jobDirectory, { client, download: false });
  const eventsAfter = (await readdir(eventsDirectory)).length;
  assert.equal(eventsAfter - eventsBefore, 3);
});

test("wait extracts the first and last frame of every downloaded take", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-wait-frames-"));
  const source = join(directory, "request.json");
  await writeFile(source, JSON.stringify(rawRequest()), "utf8");
  const plan = await planVideoJob(rawRequest(), { requestSource: source, jobsRoot: join(directory, "jobs") });
  await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo(payload) {
        return { id: "task-frames", model: payload.model, status: "pending" };
      },
    },
  });
  const completed = { id: "task-frames", status: "completed", progress: 100, results: ["https://example.test/a.mp4"] };
  const client = {
    async waitForTask() {
      return completed;
    },
    async downloadResult(_url, outputDirectory, { index }) {
      return join(outputDirectory, `result-0${index}.mp4`);
    },
  };
  const extracted = [];
  const result = await waitForVideoJob(plan.jobDirectory, {
    client,
    tools: {
      async extractFrame(output, target, { position }) {
        extracted.push(position);
        return target;
      },
    },
  });
  assert.deepEqual(extracted, ["first", "last"]);
  assert.equal(result.frames.length, 1);
  assert.match(result.frames[0].last_frame, /result-01-last\.png$/);
  assert.equal(result.frames[0].first_frame_error, undefined);
  assert.deepEqual(result.state.frames, result.frames, "frames are persisted on the job");
});
