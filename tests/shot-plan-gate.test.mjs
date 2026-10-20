import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { continuityHash, normalizeContinuity } from "../src/domain/continuity.mjs";
import { createProjectManifest, formatVideoDirectory } from "../src/domain/production-context.mjs";
import { normalizeShotPlan, shotPlanHash } from "../src/domain/shot-plan.mjs";
import { planVideoJob, submitVideoJob } from "../src/workflows/video-job.mjs";

const fixedNow = new Date("2026-08-17T09:00:00.000Z");

/** A provider client that fails loudly if the gate ever lets a call through. */
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

function documents(projectId, target = {}) {
  const continuity = normalizeContinuity({
    project_id: projectId,
    global_prompt_block: "Realistic anime.",
    required_anchor_kinds: [],
  });
  const draft = normalizeShotPlan({
    project_id: projectId,
    source_script: { path: "brief/source.md", sha256: "fixture" },
    target: { duration_seconds_total: 4, model_default: "seedance-2.5", ...target },
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
    ],
  });
  const hash = shotPlanHash(draft);
  const frozen = normalizeShotPlan({
    ...draft,
    status: "frozen",
    plan_hash: hash,
    continuity_hash: continuityHash(continuity),
    frozen_at: fixedNow.toISOString(),
    check_snapshot: { ok: true, blockers: 0, warnings: 0, checked_at: fixedNow.toISOString() },
    review: { record: "reviews/fixture.json", reviewer_pass: 1, plan_hash: hash, verdict: "approve" },
  });
  return { continuity, draft, frozen, hash };
}

async function workspace({ approval = { paid_generation: true, max_total_cost: 9 }, plan = "frozen", target = {} } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-shot-plan-gate-"));
  const videoDirectory = formatVideoDirectory(1);
  const registryRoot = join(workspaceRoot, "projects", "acme", videoDirectory);
  const jobsRoot = join(workspaceRoot, "artifacts", "acme", videoDirectory, "jobs");
  await mkdir(join(registryRoot, "brief"), { recursive: true });
  await mkdir(jobsRoot, { recursive: true });

  const projectId = `ACME-${videoDirectory}`;
  const manifest = {
    ...createProjectManifest({
      clientId: "acme",
      videoNumber: 1,
      title: "Видео",
      createdAt: fixedNow.toISOString(),
      storage: {
        mode: "standard",
        project_root: `projects/acme/${videoDirectory}`,
        jobs_root: `artifacts/acme/${videoDirectory}/jobs`,
        audio_root: `artifacts/acme/${videoDirectory}/audio`,
        masters_root: `artifacts/acme/${videoDirectory}/masters`,
      },
    }),
    approval,
  };
  await writeFile(join(registryRoot, "project.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const docs = documents(projectId, target);
  if (plan !== "absent") {
    const document = plan === "frozen" ? docs.frozen : docs.draft;
    await writeFile(join(registryRoot, "brief", "shotplan.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await writeFile(
      join(registryRoot, "brief", "continuity.json"),
      `${JSON.stringify(docs.continuity, null, 2)}\n`,
      "utf8",
    );
  }
  return { workspaceRoot, registryRoot, jobsRoot, ...docs };
}

function request({ planHash = null, shotId = "S100", durationSeconds = 4, model = "seedance-2.5", mode = "text_to_video", aspectRatio = "9:16", generateAudio = false } = {}) {
  return {
    schema_version: 1,
    shot_id: shotId,
    take_id: "T001",
    provider: "evolink",
    model,
    mode,
    prompt: "A stable vertical shot",
    duration_seconds: durationSeconds,
    aspect_ratio: aspectRatio,
    resolution: "720p",
    generate_audio: generateAudio,
    references: [],
    options: {},
    metadata: {
      production: { client_id: "acme", project_id: "ACME-V001", video_number: 1 },
      ...(planHash ? { script: { plan_hash: planHash } } : {}),
    },
  };
}

async function planned(jobsRoot, workspaceRoot, raw) {
  const source = join(workspaceRoot, `request-${raw.shot_id}-${raw.take_id}.json`);
  await writeFile(source, JSON.stringify(raw), "utf8");
  return planVideoJob(raw, { requestSource: source, jobsRoot });
}

test("planning is refused when the project has no shot plan at all", async () => {
  const { workspaceRoot, jobsRoot } = await workspace({ plan: "absent" });
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request()),
    /No frozen shot plan for ACME-V001.*script init/s,
  );
});

test("planning is refused while the plan is still a draft", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace({ plan: "draft" });
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash })),
    /is "draft", not frozen/,
  );
});

test("a request with no plan binding is refused and told how to build one", async () => {
  const { workspaceRoot, jobsRoot } = await workspace();
  await assert.rejects(planned(jobsRoot, workspaceRoot, request()), /carries no metadata\.script\.plan_hash/);
});

test("a request composed from an older plan is refused", async () => {
  const { workspaceRoot, jobsRoot } = await workspace();
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: "0".repeat(64) })),
    /was composed from plan 000000000000 but the frozen plan is/,
  );
});

test("a shot that is not in the frozen plan is refused", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace();
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash, shotId: "S999" })),
    /Shot S999 is not part of the frozen plan/,
  );
});

test("a request that quietly differs from the reviewed plan is refused", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace();
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash, durationSeconds: 6 })),
    /planned as 4 s but the request asks for 6 s/,
  );
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash, model: "kling-v3" })),
    /a model change is a plan decision/,
  );
});

test("a plan that turns model audio off refuses a request that turns it back on", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace({ target: { generate_audio: false } });
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash, generateAudio: true })),
    /planned with generate_audio=false but the request asks for true/,
  );
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash, generateAudio: false }));
  assert.equal(plan.state.script_plan.status, "approved");
});

test("a plan that leaves model audio undeclared keeps the request's choice", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace();
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash, generateAudio: true }));
  assert.equal(plan.state.script_plan.status, "approved");
});

test("a clean frozen plan lets planning through and is recorded on the job", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace();
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash }));
  assert.equal(plan.state.script_plan.status, "approved");
  assert.equal(plan.state.script_plan.plan_hash, hash);
  assert.deepEqual(plan.state.script_plan.beat_ids, ["B01"]);
});

test("editing the frozen plan on disk stops submission without touching the provider", async () => {
  const { workspaceRoot, registryRoot, jobsRoot, hash, frozen } = await workspace();
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash }));

  // The reviewer approved four seconds; someone stretches the shot afterwards
  // and leaves the stamped hash alone.
  const tampered = { ...frozen, shots: [{ ...frozen.shots[0], duration_seconds: 8, timeline_seconds: 8 }] };
  await writeFile(join(registryRoot, "brief", "shotplan.json"), `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  const client = refusingClient();
  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /was edited after freezing/,
  );
  assert.deepEqual(client.calls, []);
  const state = JSON.parse(await readFile(join(plan.jobDirectory, "job.json"), "utf8"));
  assert.equal(state.phase, "planned");
  assert.equal(state.paid_execution_started, false);
});

test("changing continuity after freezing stops submission", async () => {
  const { workspaceRoot, registryRoot, jobsRoot, hash, continuity } = await workspace();
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash }));

  const drifted = { ...continuity, global_prompt_block: "Photorealistic live action." };
  await writeFile(
    join(registryRoot, "brief", "continuity.json"),
    `${JSON.stringify(drifted, null, 2)}\n`,
    "utf8",
  );

  const client = refusingClient();
  await assert.rejects(
    submitVideoJob(plan.jobDirectory, { execute: true, client }),
    /Continuity for ACME-V001 changed after the plan was frozen/,
  );
  assert.deepEqual(client.calls, []);
});

test("submission is refused for a shot outside the plan and never reaches the provider", async () => {
  const { workspaceRoot, registryRoot, jobsRoot, hash, frozen } = await workspace();
  const plan = await planned(jobsRoot, workspaceRoot, request({ planHash: hash }));

  // The shot is dropped from the plan after the job was created.
  const withoutShot = normalizeShotPlan({ ...frozen, shots: [] , plan_hash: shotPlanHash({ ...frozen, shots: [] })});
  await writeFile(
    join(registryRoot, "brief", "shotplan.json"),
    `${JSON.stringify(withoutShot, null, 2)}\n`,
    "utf8",
  );

  const client = refusingClient();
  await assert.rejects(submitVideoJob(plan.jobDirectory, { execute: true, client }));
  assert.deepEqual(client.calls, []);
});

test("a named waiver exempts only the shots it lists", async () => {
  const { workspaceRoot, jobsRoot } = await workspace({
    plan: "absent",
    approval: {
      paid_generation: true,
      max_total_cost: 9,
      script_plan_waiver: {
        reason: "Отснято до появления гейта",
        waived_by: "producer",
        waived_at: fixedNow.toISOString(),
        shot_ids: ["S100"],
      },
    },
  });

  const waived = await planned(jobsRoot, workspaceRoot, request());
  assert.equal(waived.state.script_plan.status, "waived");
  assert.equal(waived.state.script_plan.reason, "Отснято до появления гейта");

  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ shotId: "S200" })),
    /No frozen shot plan for ACME-V001/,
  );
});

test("an ad-hoc job outside any project is left alone by the gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lidfly-shot-plan-free-"));
  const jobsRoot = join(directory, "jobs");
  const raw = { ...request(), metadata: {} };
  const plan = await planned(jobsRoot, directory, raw);
  assert.equal(plan.state.script_plan.status, "not_project_bound");
});

test("the script gate answers before the budget gate", async () => {
  // No plan and no money left: the more basic refusal is the one about the plan.
  const { workspaceRoot, jobsRoot } = await workspace({
    plan: "absent",
    approval: { paid_generation: true, max_total_cost: 0 },
  });
  await assert.rejects(planned(jobsRoot, workspaceRoot, request()), /No frozen shot plan/);
});

test("a request that flips the orientation away from the frozen plan is refused", async () => {
  const { workspaceRoot, jobsRoot, hash } = await workspace();
  await assert.rejects(
    planned(jobsRoot, workspaceRoot, request({ planHash: hash, aspectRatio: "16:9" })),
    /Shot S100 is planned as 9:16 but the request asks for 16:9: an aspect ratio change is a plan decision/,
  );
});
