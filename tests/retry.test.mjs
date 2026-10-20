import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findJobs, nextTakeId, prepareRetry } from "../src/workflows/retry.mjs";
import { planVideoJob, submitVideoJob } from "../src/workflows/video-job.mjs";

function rawRequest(takeId = "T001") {
  return {
    schema_version: 1,
    shot_id: "S102",
    take_id: takeId,
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "Она поворачивает телефон экраном к объективу",
    duration_seconds: 4,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: true,
    references: [],
    options: {},
    metadata: { edit_purpose: "TURN" },
  };
}

/** Plan a take and drive it to the failure the provider actually returns. */
async function failedTake(directory, takeId, { code = "content_policy_violation" } = {}) {
  const source = join(directory, `S102-${takeId}-seedance.json`);
  const raw = rawRequest(takeId);
  await writeFile(source, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const plan = await planVideoJob(raw, { requestSource: source, jobsRoot: join(directory, "jobs") });
  await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo() {
        return { id: `task-${takeId}`, status: "pending" };
      },
    },
  });
  // The provider reports moderation refusal on the task, not on submission.
  const statePath = join(plan.jobDirectory, "job.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        phase: "failed",
        provider_error: { code, message: "The generated video was blocked by content moderation." },
        usage: { billing_rule: "per_second", credits_reserved: 80.36 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { plan, source };
}

test("next take continues the numbering and skips takes already planned", () => {
  assert.equal(nextTakeId("T001", ["T001"]), "T002");
  assert.equal(nextTakeId("T001", ["T001", "T002", "T003"]), "T004");
  assert.equal(nextTakeId("T009", ["T009"]), "T010");
  assert.equal(nextTakeId("B1", ["B1"]), "B2");
  assert.throws(() => nextTakeId("final", ["final"]), /Cannot derive the next take/);
});

test("retry clones the failed request as the next take and records why it differs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-retry-"));
  const { plan } = await failedTake(directory, "T001");

  const result = await prepareRetry(plan.jobDirectory, {
    change: "телефон убран из кадра",
  });

  assert.equal(result.take_id, "T002");
  assert.equal(result.retry_request_path, join(directory, "S102-T002-seedance.json"));
  assert.equal(result.retry_of.provider_error_code, "content_policy_violation");
  assert.equal(result.retry_of.take_id, "T001");

  const written = JSON.parse(await readFile(result.retry_request_path, "utf8"));
  assert.equal(written.take_id, "T002");
  assert.equal(written.metadata.retry_change, "телефон убран из кадра");
  assert.equal(written.metadata.edit_purpose, "TURN", "author metadata is preserved");
  // The prompt is untouched: choosing the one variable to change stays manual.
  assert.equal(written.prompt, rawRequest().prompt);
  assert.match(result.next_step, /plan --request/);
});

test("consecutive retries keep advancing the take number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-retry-chain-"));
  await failedTake(directory, "T001");
  const second = await failedTake(directory, "T002");
  const third = await failedTake(directory, "T003");

  const result = await prepareRetry(third.plan.jobDirectory, { change: "план по плечи" });
  assert.equal(result.take_id, "T004");

  // Retrying an earlier failure must not collide with takes already planned.
  const fromSecond = await prepareRetry(second.plan.jobDirectory, {
    change: "другая формулировка одежды",
    takeId: "T005",
  });
  assert.equal(fromSecond.take_id, "T005");
});

test("retry refuses anything that is not a finished failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-retry-phase-"));
  const source = join(directory, "S102-T001-seedance.json");
  const raw = rawRequest();
  await writeFile(source, JSON.stringify(raw), "utf8");
  const plan = await planVideoJob(raw, { requestSource: source, jobsRoot: join(directory, "jobs") });

  await assert.rejects(
    prepareRetry(plan.jobDirectory, { change: "что-то" }),
    /Job phase is "planned"/,
  );
  await assert.rejects(prepareRetry(plan.jobDirectory, {}), /--change must be a non-empty string/);
});

test("jobs index reports the moderation history and only charged spend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-jobs-index-"));
  const jobsRoot = join(directory, "jobs");
  await failedTake(directory, "T001");
  await failedTake(directory, "T002");

  // A completed, charged take in another shot.
  const okDirectory = join(jobsRoot, "S103", "T001-abcdef012345");
  await mkdir(okDirectory, { recursive: true });
  await writeFile(
    join(okDirectory, "job.json"),
    JSON.stringify({
      phase: "completed",
      resolved_model_id: "seedance-2.5-reference-to-video",
      usage: { cost: { usd: 1.478 } },
      updated_at: "2026-08-14T12:00:00.000Z",
    }),
    "utf8",
  );

  const all = await findJobs(jobsRoot);
  assert.equal(all.count, 3);
  assert.equal(all.charged_usd, 1.478, "refused takes are free");

  const refused = await findJobs(jobsRoot, { shotId: "S102", phase: "failed" });
  assert.equal(refused.count, 2);
  assert.ok(refused.jobs.every((job) => job.provider_error_code === "content_policy_violation"));
  assert.deepEqual(refused.jobs.map((job) => job.take_id).sort(), ["T001", "T002"]);

  const latest = await findJobs(jobsRoot, { latest: true });
  assert.equal(latest.count, 1);
  assert.deepEqual(latest.jobs[0], all.jobs.at(-1), "latest is the most recently updated job");
});
