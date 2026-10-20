import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { continuityHash as continuityHashOf, normalizeContinuity } from "../src/domain/continuity.mjs";
import {
  createProjectManifest,
  formatVideoDirectory,
} from "../src/domain/production-context.mjs";
import { normalizeShotPlan, shotPlanHash } from "../src/domain/shot-plan.mjs";
import { readProjectBudget, sumProjectSpendUsd } from "../src/workflows/budget.mjs";
import { planVideoJob, submitVideoJob } from "../src/workflows/video-job.mjs";

const fixedNow = new Date("2026-08-14T09:00:00.000Z");

function storage(clientId, videoNumber) {
  const videoDirectory = formatVideoDirectory(videoNumber);
  return {
    mode: "standard",
    project_root: `projects/${clientId}/${videoDirectory}`,
    jobs_root: `artifacts/${clientId}/${videoDirectory}/jobs`,
    audio_root: `artifacts/${clientId}/${videoDirectory}/audio`,
    masters_root: `artifacts/${clientId}/${videoDirectory}/masters`,
  };
}

function request({ clientId = "acme", videoNumber = 1, takeId = "T001", bound = true, planHash = null, shotId = "S100" } = {}) {
  return {
    schema_version: 1,
    shot_id: shotId,
    take_id: takeId,
    provider: "evolink",
    model: "seedance-2.5",
    mode: "text_to_video",
    prompt: "A stable vertical shot",
    duration_seconds: 4,
    aspect_ratio: "9:16",
    resolution: "720p",
    generate_audio: false,
    references: [],
    options: {},
    ...(bound
      ? {
          metadata: {
            production: {
              client_id: clientId,
              project_id: `${clientId.toUpperCase()}-${formatVideoDirectory(videoNumber)}`,
              video_number: videoNumber,
            },
            ...(planHash ? { script: { plan_hash: planHash } } : {}),
          },
        }
      : {}),
  };
}

/**
 * The smallest frozen plan the script gate accepts, so these budget tests keep
 * testing the budget. The hash is computed, never pasted: a schema change must
 * not rot the fixtures silently.
 */
function frozenPlanDocuments(projectId, frozenAt) {
  const continuity = normalizeContinuity({
    project_id: projectId,
    global_prompt_block: "Realistic anime.",
    required_anchor_kinds: [],
    anchors: {},
    entities: {},
  });
  const plan = normalizeShotPlan({
    project_id: projectId,
    source_script: { path: "brief/source.md", sha256: "fixture" },
    target: { duration_seconds_total: 4, model_default: "seedance-2.5" },
    beats: [{ beat_id: "B01", label: "Единственный бит", importance: "required" }],
    shots: [
      {
        shot_id: "S100",
        beat_ids: ["B01"],
        edit_purpose: "фикстура",
        duration_seconds: 4,
        shot_size: "wide",
        subject: [],
        events: [{ event_id: "E1", text: "a stable vertical shot holds" }],
        route: { model: "seedance-2.5", mode: "text_to_video" },
      },
      {
        shot_id: "S101",
        beat_ids: ["B01"],
        edit_purpose: "фикстура на пять секунд",
        duration_seconds: 5,
        shot_size: "wide",
        subject: [],
        events: [{ event_id: "E1", text: "the same stable shot, one second longer" }],
        route: { model: "seedance-2.5", mode: "text_to_video" },
      },
    ],
    review: { record: "reviews/fixture.json", reviewer_pass: 1, plan_hash: "pending", verdict: "approve" },
  });
  const hash = shotPlanHash(plan);
  return {
    continuity,
    plan: normalizeShotPlan({
      ...plan,
      status: "frozen",
      plan_hash: hash,
      continuity_hash: continuityHashOf(continuity),
      frozen_at: frozenAt,
      check_snapshot: { ok: true, blockers: 0, warnings: 0, checked_at: frozenAt },
      review: { record: "reviews/fixture.json", reviewer_pass: 1, plan_hash: hash, verdict: "approve" },
    }),
    hash,
  };
}

/** A workspace laid out exactly like the production bootstrap creates it. */
async function productionWorkspace({ approval, clientId = "acme", videoNumber = 1 } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-budget-"));
  const videoDirectory = formatVideoDirectory(videoNumber);
  const registryRoot = join(workspaceRoot, "projects", clientId, videoDirectory);
  const jobsRoot = join(workspaceRoot, "artifacts", clientId, videoDirectory, "jobs");
  await mkdir(registryRoot, { recursive: true });
  await mkdir(jobsRoot, { recursive: true });

  if (approval !== null) {
    const manifest = {
      ...createProjectManifest({
        clientId,
        videoNumber,
        title: "Видео",
        createdAt: fixedNow.toISOString(),
        storage: storage(clientId, videoNumber),
      }),
      approval,
    };
    await writeFile(
      join(registryRoot, "project.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  const projectId = `${clientId.toUpperCase()}-${videoDirectory}`;
  const { plan, continuity, hash } = frozenPlanDocuments(projectId, fixedNow.toISOString());
  await mkdir(join(registryRoot, "brief"), { recursive: true });
  await writeFile(join(registryRoot, "brief", "shotplan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(
    join(registryRoot, "brief", "continuity.json"),
    `${JSON.stringify(continuity, null, 2)}\n`,
    "utf8",
  );
  return { workspaceRoot, jobsRoot, planHash: hash };
}

/** A completed job as the provider actually records it, for spend accounting. */
async function recordJob(jobsRoot, { shotId = "S001", take = "T001-abc", usage }) {
  const directory = join(jobsRoot, shotId, take);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "job.json"),
    `${JSON.stringify({ schema_version: 1, phase: "completed", usage }, null, 2)}\n`,
    "utf8",
  );
}

/** A job that has started paying but has not been billed yet, exactly as submit leaves it. */
async function recordReservedJob(jobsRoot, { shotId = "S001", take = "T001-abc", estimatedUsd, phase = "processing" }) {
  const directory = join(jobsRoot, shotId, take);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "job.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        phase,
        paid_execution_started: true,
        usage: { credits_reserved: 80.36 },
        cost_estimate: { status: "estimated", usd: estimatedUsd },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function refusingClient() {
  const calls = [];
  return {
    calls,
    async submitVideo(payload) {
      calls.push(payload);
      throw new Error("The gate should have blocked this call before it reached the provider");
    },
    async uploadImage() {
      calls.push("upload");
      throw new Error("The gate should have blocked this call before any upload");
    },
  };
}

async function planned(jobsRoot, source, raw) {
  await writeFile(source, JSON.stringify(raw), "utf8");
  return planVideoJob(raw, { requestSource: source, jobsRoot });
}

test("submission is refused while paid generation is not approved", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: false, max_total_cost: 9 },
  });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ planHash }));
  const client = refusingClient();

  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /Paid generation is not approved for ACME-V001/,
  );
  assert.deepEqual(client.calls, []);

  const state = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(join(plan.jobDirectory, "job.json"), "utf8")),
  );
  assert.equal(state.phase, "planned");
  assert.equal(state.paid_execution_started, false);
});

test("submission is refused once recorded spend reaches the approved cap", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 2 },
  });
  await recordJob(jobsRoot, { shotId: "S001", take: "T001-aaa", usage: { cost: { usd: 1.182 } } });
  await recordJob(jobsRoot, { shotId: "S002", take: "T001-bbb", usage: { cost: { usd: 1.182 } } });

  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ planHash }));
  const client = refusingClient();

  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /Budget exceeded for ACME-V001: spent \$2\.364 .* approved cap of \$2\.000/,
  );
  assert.deepEqual(client.calls, []);
});

test("the projected total blocks a job that would tip the project over the cap", async () => {
  // $7.684 already charged against a $9 cap,
  // and the next 5s Seedance 2.5 shot would cost about $1.48.
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 9 },
  });
  for (const [shot, usd] of [
    ["S001", 1.182], ["S002", 1.182], ["S003", 1.478],
    ["S101", 1.182], ["S102", 1.182], ["S103", 1.478],
  ]) {
    await recordJob(jobsRoot, { shotId: shot, take: `T001-${shot}`, usage: { cost: { usd } } });
  }

  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, { ...request({ planHash, shotId: "S101" }), duration_seconds: 5 });
  assert.equal(plan.state.cost_estimate.status, "estimated");
  assert.equal(plan.state.cost_estimate.credits, 100.45);

  const client = refusingClient();
  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /spent \$7\.684 \+ estimated \$1\.479 = \$9\.163 over the approved cap of \$9\.000/,
  );
  assert.deepEqual(client.calls, []);

  // The same project still accepts a job that fits inside what is left.
  const shorter = await planned(
    jobsRoot,
    join(workspaceRoot, "request-short.json"),
    { ...request({ takeId: "T002", planHash }), duration_seconds: 4 },
  );
  const accepted = await submitVideoJob(shorter.jobDirectory, {
    execute: true,
    client: { async submitVideo() { return { id: "task-fits", status: "pending" }; } },
  });
  assert.equal(accepted.state.budget.spent_usd, 7.684);
  assert.equal(accepted.state.budget.estimated_usd, 1.183);
});

test("an unmeasured route is allowed but flagged, checked against recorded spend only", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 5 },
  });
  await recordJob(jobsRoot, { shotId: "S001", take: "T001-aaa", usage: { cost: { usd: 1 } } });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, { ...request({ planHash }), resolution: "480p" });
  assert.equal(plan.state.cost_estimate.status, "unknown_rate");

  const result = await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: { async submitVideo() { return { id: "task-unknown", status: "pending" }; } },
  });
  assert.equal(result.state.budget.status, "approved");
  assert.equal(result.state.budget.estimate_status, "unknown_rate");
  assert.match(result.state.budget.warning, /No measured price/);
});

test("only charged cost counts as spend; reserved credits and running jobs do not", async () => {
  const { jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 9 },
  });
  // Charged.
  await recordJob(jobsRoot, { shotId: "S001", take: "T001-aaa", usage: { cost: { usd: 1.182 } } });
  await recordJob(jobsRoot, { shotId: "S003", take: "T001-ccc", usage: { cost: { usd: 1.478 } } });
  // Rejected by moderation: reserved, never charged.
  await recordJob(jobsRoot, {
    shotId: "S102",
    take: "T001-ddd",
    usage: { billing_rule: "per_second", credits_reserved: 80.36 },
  });
  // Still running.
  await recordJob(jobsRoot, { shotId: "S102", take: "T004-eee", usage: null });

  const spend = await sumProjectSpendUsd(jobsRoot);
  assert.equal(spend.usd, 2.66);
  assert.equal(spend.jobs.length, 2);
});

test("a job outside any project is left alone by the gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-budget-free-"));
  const jobsRoot = join(directory, "jobs");
  const source = join(directory, "request.json");
  const plan = await planned(jobsRoot, source, request({ bound: false }));

  const client = {
    async submitVideo() {
      return { id: "task-1", status: "pending", model: "seedance-2.5-text-to-video" };
    },
  };
  const result = await submitVideoJob(plan.jobDirectory, { execute: true, client });
  assert.equal(result.state.remote_task_id, "task-1");
  assert.equal(result.state.budget.status, "not_project_bound");
});

test("an uncapped project is approved but the decision says so", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: null },
  });
  await recordJob(jobsRoot, { shotId: "S001", take: "T001-aaa", usage: { cost: { usd: 5 } } });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ planHash }));

  const result = await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo() {
        return { id: "task-2", status: "pending" };
      },
    },
  });
  assert.equal(result.state.budget.status, "approved");
  assert.equal(result.state.budget.max_total_cost, null);
  assert.match(result.state.budget.note, /not capped/);
});

test("an already submitted job stays idempotent even when the cap is now exhausted", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 9 },
  });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ planHash }));
  const first = await submitVideoJob(plan.jobDirectory, {
    execute: true,
    client: {
      async submitVideo() {
        return { id: "task-3", status: "pending" };
      },
    },
  });
  assert.equal(first.state.remote_task_id, "task-3");

  // The cap is exhausted after the fact; a repeat must still return the same task
  // rather than being blocked into an ambiguous state.
  await recordJob(jobsRoot, { shotId: "S999", take: "T001-zzz", usage: { cost: { usd: 100 } } });
  const client = refusingClient();
  const second = await submitVideoJob(plan.jobDirectory, { execute: true, client });
  assert.equal(second.reused, true);
  assert.equal(second.state.remote_task_id, "task-3");
  assert.deepEqual(client.calls, []);
});

test("a missing project manifest fails closed instead of spending", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({ approval: null });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ planHash }));
  const client = refusingClient();

  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /Project manifest is missing/,
  );
  assert.deepEqual(client.calls, []);
});

test("the gate refuses a job whose declared project does not match its directory", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 9 },
    clientId: "acme",
  });
  // Plan into acme's jobs root while the manifest on disk belongs to acme,
  // then swap the declared identity to a different project.
  const source = join(workspaceRoot, "request.json");
  const raw = request({ planHash });
  const plan = await planned(jobsRoot, source, raw);

  const foreign = { ...raw, metadata: { production: { client_id: "other", project_id: "OTHER-V001", video_number: 1 } } };
  await writeFile(source, JSON.stringify(foreign), "utf8");

  // The request hash check catches the swap first — the immutability guarantee
  // is what protects the budget here, and it must not be bypassable.
  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client: refusingClient() }),
    /Request source changed after planning/,
  );
});

test("a submitted but unbilled job holds its estimate against the cap", async () => {
  const { workspaceRoot, jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 3 },
  });
  // Two jobs are already in flight: submit recorded credits_reserved, and
  // usage.cost only appears after wait. Counting charged spend alone would let
  // a third job through and blow the cap collectively.
  await recordReservedJob(jobsRoot, { shotId: "S001", take: "T001-aaa", estimatedUsd: 1.183 });
  await recordReservedJob(jobsRoot, { shotId: "S002", take: "T001-bbb", estimatedUsd: 1.183 });
  const source = join(workspaceRoot, "request.json");
  const plan = await planned(jobsRoot, source, request({ takeId: "T003", planHash }));
  const client = refusingClient();

  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /reserved \$2\.366 \+ estimated \$1\.183 = \$3\.549 over the approved cap of \$3\.000/,
  );
  assert.deepEqual(client.calls, []);
});

test("a job reconciled as lost releases the money it was holding", async () => {
  const { jobsRoot } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 8 },
  });
  await recordReservedJob(jobsRoot, { shotId: "S002", take: "T001-aaa", estimatedUsd: 1.183 });

  const holding = await readProjectBudget({ jobsRoot });
  assert.equal(holding.reserved_usd, 1.183);

  // reconcile proved against the provider's task list that no task exists.
  await recordReservedJob(jobsRoot, {
    shotId: "S002",
    take: "T001-aaa",
    estimatedUsd: 1.183,
    phase: "submission_lost",
  });
  const released = await readProjectBudget({ jobsRoot });
  assert.equal(released.reserved_usd, 0);
  assert.equal(released.remaining_usd, 8);
});

test("a planned or rejected job reserves nothing", async () => {
  const { jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 5 },
  });
  await recordReservedJob(jobsRoot, { shotId: "S001", take: "T001-aaa", estimatedUsd: 1.183, phase: "planned" });
  await recordReservedJob(jobsRoot, { shotId: "S002", take: "T001-bbb", estimatedUsd: 1.183, phase: "submission_rejected" });

  const budget = await readProjectBudget({ jobsRoot });
  assert.equal(budget.reserved_usd, 0);
  assert.equal(budget.committed_usd, 0);
  assert.equal(budget.remaining_usd, 5);
});

test("the read-only budget view reports charged, reserved, and what is left", async () => {
  const { jobsRoot, planHash } = await productionWorkspace({
    approval: { paid_generation: true, max_total_cost: 8 },
  });
  await recordJob(jobsRoot, { shotId: "S001", take: "T001-aaa", usage: { cost: { usd: 1.182 } } });
  await recordReservedJob(jobsRoot, { shotId: "S002", take: "T001-bbb", estimatedUsd: 1.183 });

  const budget = await readProjectBudget({ jobsRoot });
  assert.equal(budget.status, "resolved");
  assert.equal(budget.project_id, "ACME-V001");
  assert.equal(budget.paid_generation, true);
  assert.equal(budget.spent_usd, 1.182);
  assert.equal(budget.reserved_usd, 1.183);
  assert.equal(budget.committed_usd, 2.365);
  assert.equal(budget.remaining_usd, 5.635);
  assert.equal(budget.jobs.length, 2);
  // sumProjectSpendUsd keeps its narrow meaning: money already billed.
  assert.equal((await sumProjectSpendUsd(jobsRoot)).usd, 1.182);
});

test("the read-only budget view leaves an ad-hoc jobs root alone", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-budget-adhoc-"));
  const jobsRoot = join(workspaceRoot, "artifacts", "jobs");
  await mkdir(jobsRoot, { recursive: true });

  const budget = await readProjectBudget({ jobsRoot });
  assert.equal(budget.status, "not_project_bound");
});
