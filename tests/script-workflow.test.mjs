import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeContinuity } from "../src/domain/continuity.mjs";
import { shotPlanHash } from "../src/domain/shot-plan.mjs";
import { bootstrapProduction } from "../src/workflows/production-bootstrap.mjs";
import {
  checkShotPlan,
  composeShotRequests,
  freezeShotPlan,
  initShotPlan,
  recordShotPlanReview,
  shotPlanStatus,
} from "../src/workflows/shot-plan.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "src", "cli.mjs");
const fixedNow = new Date("2026-08-17T09:00:00.000Z");

async function project() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-script-"));
  const context = await bootstrapProduction({
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    mode: "ensure",
    title: "Тестовый ролик",
    workspaceRoot,
  });
  const scriptPath = join(workspaceRoot, context.project_root, "brief", "source-script.md");
  await writeFile(scriptPath, "# Сценарий\n\nМальчик на мосту.\n", "utf8");
  return { workspaceRoot, projectRoot: context.project_root, scriptPath };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** A plan that passes every machine check, written straight onto disk. */
async function writeCleanPlan({ workspaceRoot, projectRoot }, target = {}) {
  const planPath = join(workspaceRoot, projectRoot, "brief", "shotplan.json");
  const continuityPath = join(workspaceRoot, projectRoot, "brief", "continuity.json");
  const plan = await readJson(planPath);
  Object.assign(plan.target, target);
  plan.beats = [
    { beat_id: "B01", label: "Ловушка", kind: "setup", importance: "required" },
    { beat_id: "B02", label: "Решение", kind: "turn", importance: "required" },
  ];
  plan.shots = [
    {
      shot_id: "S001",
      beat_ids: ["B01"],
      source: "generated",
      edit_purpose: "установка",
      duration_seconds: 4,
      timeline_seconds: 4,
      shot_size: "wide",
      subject: ["mark"],
      continuity_keys: ["light.evening", "location.bridge"],
      identity_refs: [],
      route: { model: "seedance-2.5", mode: "text_to_video" },
      events: [{ event_id: "E1", text: "the boy stops at the middle of the span" }],
    },
    {
      shot_id: "S002",
      beat_ids: ["B02"],
      source: "generated",
      edit_purpose: "поворот",
      duration_seconds: 4,
      timeline_seconds: 4,
      shot_size: "close_up",
      subject: ["mark"],
      continuity_keys: ["light.evening", "location.bridge"],
      identity_refs: [],
      route: { model: "seedance-2.5", mode: "text_to_video" },
      events: [{ event_id: "E1", text: "his eyes find the loose pin" }],
    },
  ];
  plan.target.duration_seconds_total = 8;
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const continuity = normalizeContinuity({
    ...(await readJson(continuityPath)),
    global_prompt_block: "Realistic anime, vertical 9:16.",
    negative_prompt_block: "No text.",
    required_anchor_kinds: ["light", "location"],
    anchors: {
      "light.evening": { kind: "light", text: "Copper evening light." },
      "location.bridge": { kind: "location", text: "One rusted footbridge." },
    },
    entities: {
      mark: {
        kind: "character",
        role: "protagonist",
        prompt_text: "A teenage boy about fifteen",
        invariants: ["entirely black eyes"],
        signature_feature: "чёрные глаза",
        requires_close_up: true,
      },
    },
  });
  await writeFile(continuityPath, `${JSON.stringify(continuity, null, 2)}\n`, "utf8");
  return { planPath, continuityPath };
}

async function approveReview({ workspaceRoot, projectRoot }, overrides = {}) {
  const planPath = join(workspaceRoot, projectRoot, "brief", "shotplan.json");
  const plan = await readJson(planPath);
  const record = {
    schema_version: 1,
    project_id: plan.project_id,
    plan_hash: shotPlanHash(plan),
    reviewer_pass: 1,
    beat_verdicts: plan.beats.map((beat) => ({ beat_id: beat.beat_id, covered_by: [], verdict: "pass" })),
    findings: [],
    verdict: "approve",
    reviewed_at: fixedNow.toISOString(),
    reviewer: "independent-subagent",
    ...overrides,
  };
  const recordPath = join(workspaceRoot, "review.json");
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

test("init creates a draft plan bound to the source script and its hash", async () => {
  const context = await project();
  const result = await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 30,
    now: fixedNow,
  });
  assert.equal(result.shots_seeded, 0);

  const plan = await readJson(join(context.workspaceRoot, result.plan_path));
  assert.equal(plan.status, "draft");
  assert.equal(plan.project_id, "ACME-V001");
  assert.match(plan.source_script.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.target.duration_seconds_total, 30);
});

test("init --adopt recovers shots from existing requests but demands the story back", async () => {
  const context = await project();
  const requestsRoot = join(context.workspaceRoot, context.projectRoot, "requests");
  await writeFile(
    join(requestsRoot, "S001-T001.json"),
    JSON.stringify({ shot_id: "S001", take_id: "T001", duration_seconds: 4, mode: "text_to_video" }),
    "utf8",
  );

  const result = await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 30,
    adopt: true,
    now: fixedNow,
  });
  assert.equal(result.shots_seeded, 1);

  // Beats and events cannot be recovered from prose, so the check demands them.
  const check = await checkShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot });
  assert.equal(check.ok, false);
  const codes = check.findings.map((item) => item.code);
  assert.ok(codes.includes("plan_has_no_beats"));
  assert.ok(codes.includes("shot_without_event"));
});

test("freeze refuses while any blocker is open", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 30,
    now: fixedNow,
  });
  await assert.rejects(
    freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot }),
    /blocker\(s\); freeze is only possible on a clean check/,
  );
});

test("freeze refuses a clean plan that no independent reviewer has seen", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context);
  const check = await checkShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot });
  assert.equal(check.ok, true, JSON.stringify(check.findings));

  await assert.rejects(
    freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot }),
    /no independent review recorded/,
  );
});

test("a review written for an older plan is refused", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context);
  const recordPath = await approveReview(context, { plan_hash: "f".repeat(64) });

  await assert.rejects(
    recordShotPlanReview({
      workspaceRoot: context.workspaceRoot,
      projectRoot: context.projectRoot,
      recordPath,
    }),
    /перезапросите ревью после правок/,
  );
});

test("a review asking for revisions leaves the plan unfreezable", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context);
  const recordPath = await approveReview(context, {
    verdict: "revise",
    findings: [{ level: "blocker", code: "climax_shared_with_setup", message: "кульминация делит шот" }],
  });
  const recorded = await recordShotPlanReview({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    recordPath,
  });
  assert.equal(recorded.blockers_open, 1);
  assert.equal(recorded.plan_status, "draft");

  await assert.rejects(
    freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot }),
    /verdict is "revise"/,
  );
});

test("check, review, freeze and compose walk a plan all the way to a request", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context);
  const recordPath = await approveReview(context);
  await recordShotPlanReview({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    recordPath,
  });

  const frozen = await freezeShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    now: fixedNow,
  });
  assert.equal(frozen.reused, false);
  assert.match(frozen.plan_hash, /^[a-f0-9]{64}$/);

  // Freezing twice is idempotent, not a second version.
  const again = await freezeShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    now: fixedNow,
  });
  assert.equal(again.reused, true);

  const composed = await composeShotRequests({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
  });
  assert.equal(composed.requests.length, 2);
  const request = await readJson(join(context.workspaceRoot, composed.requests[0].path));
  assert.equal(request.metadata.script.plan_hash, frozen.plan_hash);
  assert.equal(request.metadata.production.project_id, "ACME-V001");
  assert.match(request.prompt, /Realistic anime/);
  assert.match(request.prompt, /Copper evening light/);
  assert.match(request.prompt, /0-4s: the boy stops at the middle of the span/);

  // Re-composing the same plan rewrites nothing.
  const repeat = await composeShotRequests({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
  });
  assert.ok(repeat.requests.every((item) => item.reused === true));
});

test("a plan that turns model audio off composes silent requests", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context, { generate_audio: false });
  const recordPath = await approveReview(context);
  await recordShotPlanReview({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot, recordPath });
  await freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot, now: fixedNow });

  const composed = await composeShotRequests({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot });
  for (const item of composed.requests) {
    const request = await readJson(join(context.workspaceRoot, item.path));
    assert.equal(request.generate_audio, false);
  }
});

test("editing a frozen plan is visible in status and blocks compose", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  const { planPath } = await writeCleanPlan(context);
  const recordPath = await approveReview(context);
  await recordShotPlanReview({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    recordPath,
  });
  await freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot, now: fixedNow });

  const plan = await readJson(planPath);
  plan.shots[0].duration_seconds = 6;
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const status = await shotPlanStatus({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot });
  assert.equal(status.plan_tampered, true);
  assert.equal(status.gate_ready, false);

  await assert.rejects(
    composeShotRequests({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot }),
    /was edited after freezing/,
  );
});

test("compose --dry-run prints the prompt blocks and writes nothing", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    now: fixedNow,
  });
  await writeCleanPlan(context);
  const recordPath = await approveReview(context);
  await recordShotPlanReview({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    recordPath,
  });
  await freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot, now: fixedNow });

  const dry = await composeShotRequests({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    dryRun: true,
  });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.requests[0].blocks.some((block) => block.name === "events"));
  await assert.rejects(readFile(join(context.workspaceRoot, dry.requests[0].path), "utf8"));
});

test("script check exits non-zero through the CLI when a blocker is open", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 30,
    now: fixedNow,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "script",
      "check",
      "--workspace-root",
      context.workspaceRoot,
      "--project",
      context.projectRoot,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert.ok(report.findings.some((item) => item.code === "plan_has_no_beats"));
      return true;
    },
  );
});

test("an unknown script subcommand lists the valid ones", async () => {
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "script", "explode"]), (error) => {
    assert.match(error.stderr, /Unknown script subcommand: explode; use init, check, review, freeze, compose, or status/);
    return true;
  });
});

test("a landscape project composes landscape requests", async () => {
  const context = await project();
  await initShotPlan({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    scriptPath: context.scriptPath,
    durationSeconds: 8,
    aspectRatio: "16:9",
    now: fixedNow,
  });
  await writeCleanPlan(context);
  await recordShotPlanReview({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    recordPath: await approveReview(context),
  });
  await freezeShotPlan({ workspaceRoot: context.workspaceRoot, projectRoot: context.projectRoot });
  const composed = await composeShotRequests({
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
  });

  const written = await Promise.all(
    composed.requests.map((entry) => readJson(join(context.workspaceRoot, entry.path))),
  );
  assert.deepEqual(
    written.map((request) => [request.shot_id, request.aspect_ratio]),
    [
      ["S001", "16:9"],
      ["S002", "16:9"],
    ],
  );
});
