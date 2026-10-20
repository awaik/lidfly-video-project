#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "skills-source");
const targets = [".agents/skills", ".codex/skills", ".claude/skills", ".openclaw/skills"];
const manifestName = ".lidfly-video-generated-skills.json";

function runSync(fixtureRoot, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts", "sync-skills.mjs"), ...args],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
}

function assertSyncFailure(result, expectedMessage) {
  assert.notEqual(result.status, 0, `sync should fail with: ${expectedMessage}`);
  assert.match(`${result.stdout}${result.stderr}`, expectedMessage);
}

function testSyncFailureModes() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lidfly-video-skills-"));
  const fixtureSkill = path.join(fixtureRoot, "skills-source", "example-skill");
  const fixtureScriptDir = path.join(fixtureRoot, "scripts");
  const fixtureSkillMarkdown = `---
name: example-skill
description: "A temporary skill used to test safe synchronization behavior."
---

# Example

Use $example-skill. Prices such as $0.30 and variables such as $job_id, $job.id, or $1 are not skill links.
`;
  const fixtureMetadata = `interface:
  display_name: "Example Skill"
  short_description: "Validate safe skill synchronization behavior"
  default_prompt: "Use $example-skill to validate synchronization."
`;

  try {
    fs.mkdirSync(path.join(fixtureSkill, "agents"), { recursive: true });
    fs.mkdirSync(fixtureScriptDir, { recursive: true });
    fs.copyFileSync(
      path.join(root, "scripts", "sync-skills.mjs"),
      path.join(fixtureScriptDir, "sync-skills.mjs"),
    );
    fs.writeFileSync(path.join(fixtureSkill, "SKILL.md"), fixtureSkillMarkdown);
    fs.writeFileSync(path.join(fixtureSkill, "agents", "openai.yaml"), fixtureMetadata);

    const initialSync = runSync(fixtureRoot);
    assert.equal(initialSync.status, 0, `${initialSync.stdout}${initialSync.stderr}`);

    const targetRoot = path.join(fixtureRoot, targets[0]);
    const targetSkill = path.join(targetRoot, "example-skill", "SKILL.md");
    const manifestPath = path.join(targetRoot, manifestName);
    const validManifest = fs.readFileSync(manifestPath, "utf8");

    fs.appendFileSync(path.join(fixtureSkill, "SKILL.md"), "\nUse $missing-skill.\n");
    assertSyncFailure(runSync(fixtureRoot, ["--check"]), /references unknown skill \$missing-skill/);
    fs.writeFileSync(path.join(fixtureSkill, "SKILL.md"), fixtureSkillMarkdown);

    fs.appendFileSync(targetSkill, "\nLocal edit that must be preserved.\n");
    assertSyncFailure(
      runSync(fixtureRoot),
      /Refusing to overwrite modified generated file/,
    );
    fs.writeFileSync(targetSkill, fixtureSkillMarkdown);

    const staleManifest = JSON.parse(validManifest);
    staleManifest.skills["example-skill"]["SKILL.md"] = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`);
    assertSyncFailure(runSync(fixtureRoot, ["--check"]), /generated manifest is missing or stale/);

    for (const invalidFiles of [null, []]) {
      const invalidManifest = JSON.parse(validManifest);
      invalidManifest.skills["example-skill"] = invalidFiles;
      fs.writeFileSync(manifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);
      assertSyncFailure(runSync(fixtureRoot, ["--check"]), /invalid generated skill example-skill/);
    }
    for (const invalidSkills of [null, []]) {
      const invalidManifest = JSON.parse(validManifest);
      invalidManifest.skills = invalidSkills;
      fs.writeFileSync(manifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);
      assertSyncFailure(runSync(fixtureRoot, ["--check"]), /invalid generated manifest/);
    }
    fs.writeFileSync(manifestPath, validManifest);

    const orphanPath = path.join(targetRoot, "example-skill", "orphan.txt");
    fs.writeFileSync(orphanPath, "Unmanaged artifact\n");
    const checkWithOrphan = runSync(fixtureRoot, ["--check"]);
    assert.equal(checkWithOrphan.status, 0, `${checkWithOrphan.stdout}${checkWithOrphan.stderr}`);
    assert.match(
      `${checkWithOrphan.stdout}${checkWithOrphan.stderr}`,
      /Warning: unmanaged entry in generated skill directory: .*orphan\.txt/,
    );

    const unmanagedSource = path.join(fixtureSkill, "references", "new.md");
    const unmanagedTarget = path.join(targetRoot, "example-skill", "references", "new.md");
    fs.mkdirSync(path.dirname(unmanagedSource), { recursive: true });
    fs.mkdirSync(path.dirname(unmanagedTarget), { recursive: true });
    fs.writeFileSync(unmanagedSource, "Canonical content\n");
    fs.writeFileSync(unmanagedTarget, "Local unmanaged content\n");
    assertSyncFailure(runSync(fixtureRoot), /Refusing to overwrite unmanaged file/);

    fs.symlinkSync("SKILL.md", path.join(fixtureSkill, "linked-skill.md"));
    assertSyncFailure(runSync(fixtureRoot, ["--check"]), /Symlinks are not allowed in skills-source/);
    fs.unlinkSync(path.join(fixtureSkill, "linked-skill.md"));

    fs.symlinkSync("example-skill", path.join(fixtureRoot, "skills-source", "linked-skill"));
    assertSyncFailure(runSync(fixtureRoot, ["--check"]), /Symlinks are not allowed in skills-source/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

execFileSync(process.execPath, [path.join(root, "scripts/sync-skills.mjs"), "--check"], {
  cwd: root,
  stdio: "inherit",
});

const skills = fs.readdirSync(sourceRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const requiredSkills = [
  "vibe-creating-prompt",
  "produce-short-video",
  "develop-shot-plan",
  "generate-kling-3-video",
  "generate-kling-o3-video",
  "generate-seedance-video",
  "review-generated-video",
  "assemble-short-video",
  "edit-with-openchatcut",
];
for (const skillName of requiredSkills) {
  assert.ok(skills.includes(skillName), `${skillName} must exist`);
}

for (const skillName of skills) {
  const sourceDir = path.join(sourceRoot, skillName);
  const sourceFiles = fs.readdirSync(sourceDir, { recursive: true })
    .filter((relativePath) => {
      const fullPath = path.join(sourceDir, relativePath);
      return fs.statSync(fullPath).isFile() && path.basename(relativePath) !== ".DS_Store";
    });
  for (const target of targets) {
    for (const relativePath of sourceFiles) {
      assert.deepEqual(
        fs.readFileSync(path.join(root, target, skillName, relativePath)),
        fs.readFileSync(path.join(sourceDir, relativePath)),
        `${target}/${skillName}/${relativePath} must match the canonical source`,
      );
    }
  }
}

const vibeSkill = fs.readFileSync(
  path.join(sourceRoot, "vibe-creating-prompt", "SKILL.md"),
  "utf8",
);
assert.match(vibeSkill, /Reels, YouTube Shorts/);
assert.match(vibeSkill, /Dialogue\/VO\/music\/SFX the user wrote out → keep verbatim/);
assert.match(vibeSkill, /do not make paid generation calls from this skill/);
assert.doesNotMatch(vibeSkill, /Atlas Cloud|atlascloud/i);
assert.doesNotMatch(vibeSkill.match(/^---\n[\s\S]*?\n---/)[0], /^license:/m);

const producerSkill = fs.readFileSync(
  path.join(sourceRoot, "produce-short-video", "SKILL.md"),
  "utf8",
);
for (const referencedSkill of requiredSkills.filter((name) => name !== "produce-short-video")) {
  assert.match(producerSkill, new RegExp(`\\$${referencedSkill}`));
}
assert.match(producerSkill, /Never silently substitute a model/);
assert.match(producerSkill, /persist the remote task ID before polling/);
assert.match(producerSkill, /provider-preflight-ready draft manifests/);
assert.match(producerSkill, /Call a manifest generation-ready only after those gates pass/);
assert.match(producerSkill, /### 0\. Resolve or initialize production/);
assert.match(producerSkill, /scripts\/init-production\.mjs/);
assert.match(producerSkill, /Do not continue a full workflow without a validated/);
assert.match(producerSkill, /"production"/);
assert.match(producerSkill, /Never add `client_id` or `project_id` at the request top level/);
assert.match(producerSkill, /--jobs-root artifacts\/acme\/V001\/jobs/);
assert.match(producerSkill, /never fall back to shared `artifacts\/jobs`/);
assert.match(producerSkill, /does not specify a model.*choose Seedance 2\.5 first/);

assert.match(producerSkill, /script freeze/);
assert.match(producerSkill, /metadata\.script\.plan_hash/);
assert.match(producerSkill, /there is no override flag/);

const shotPlanSkill = fs.readFileSync(
  path.join(sourceRoot, "develop-shot-plan", "SKILL.md"),
  "utf8",
);
// The rules that keep the gate from becoming decorative.
assert.match(shotPlanSkill, /The reviewer subagent receives exactly three inputs/);
assert.match(shotPlanSkill, /never receives the director's rationale/);
assert.match(shotPlanSkill, /a climax beat gets a shot to itself/);
assert.match(shotPlanSkill, /There is no override flag/);
assert.match(shotPlanSkill, /A shot has no prompt field/);
assert.match(shotPlanSkill, /never on the command line/);

const shotPlanRubric = fs.readFileSync(
  path.join(sourceRoot, "develop-shot-plan", "references", "shotplan-review-rubric.md"),
  "utf8",
);
assert.match(shotPlanRubric, /## Hard gates/);
assert.match(shotPlanRubric, /## Weighted score/);
assert.match(shotPlanRubric, /## Rewrite diagnosis/);

const shotPlanContract = fs.readFileSync(
  path.join(sourceRoot, "develop-shot-plan", "references", "shotplan-contract.md"),
  "utf8",
);
assert.match(shotPlanContract, /shotplan\.json/);
assert.match(shotPlanContract, /continuity\.json/);
assert.match(shotPlanContract, /script_plan_waiver/);

const productionFlow = fs.readFileSync(
  path.join(sourceRoot, "produce-short-video", "references", "production-flow.md"),
  "utf8",
);
assert.match(productionFlow, /projects\/<client_id>\/\n  client\.json/);
assert.match(productionFlow, /projects\/<client_id>\/VNNN\//);
assert.match(productionFlow, /artifacts\/<client_id>\/VNNN\//);
assert.match(productionFlow, /shotplan\.json/);
assert.match(productionFlow, /continuity\.json/);
assert.match(productionFlow, /Shot-plan gate/);
assert.match(productionFlow, /metadata\.production/);

const klingO3Skill = fs.readFileSync(
  path.join(sourceRoot, "generate-kling-o3-video", "SKILL.md"),
  "utf8",
);
assert.match(klingO3Skill, /label is ambiguous across providers/);
assert.match(klingO3Skill, /Do not guess/);

const seedanceReference = fs.readFileSync(
  path.join(sourceRoot, "generate-seedance-video", "references", "byteplus-api.md"),
  "utf8",
);
assert.match(seedanceReference, /dreamina-seedance-2-0-260128/);
assert.match(seedanceReference, /audio cannot be the only modality/);
assert.match(seedanceReference, /rather than submitting again/i);
const evolinkSeedanceReference = fs.readFileSync(
  path.join(sourceRoot, "generate-seedance-video", "references", "evolink-api.md"),
  "utf8",
);
assert.match(evolinkSeedanceReference, /seedance-2\.5-text-to-video/);
assert.match(evolinkSeedanceReference, /seedance-2\.5-video-extend/);
assert.match(evolinkSeedanceReference, /request default when `model` is omitted/);

const reviewSkill = fs.readFileSync(
  path.join(sourceRoot, "review-generated-video", "SKILL.md"),
  "utf8",
);
assert.match(reviewSkill, /Do not average a hard failure into a passing score/);
assert.match(reviewSkill, /Never delete rejected takes/);

const assemblySkill = fs.readFileSync(
  path.join(sourceRoot, "assemble-short-video", "SKILL.md"),
  "utf8",
);
assert.match(assemblySkill, /Never accept an unreviewed take/);
assert.match(assemblySkill, /Do not publish or upload/);
assert.match(assemblySkill, /--require-review/);
assert.match(assemblySkill, /subject_checked_at_seconds/);
assert.match(assemblySkill, /persist the task ID before polling/);
assert.match(assemblySkill, /exact logos, UI, prices, claims, captions, and CTA/);
assert.match(assemblySkill, /approved VO, music, ambience, and SFX/);
assert.match(assemblySkill, /write proxies, intermediates, and masters to new paths/);

const editManifestReference = fs.readFileSync(
  path.join(sourceRoot, "assemble-short-video", "references", "edit-manifest.md"),
  "utf8",
);
// The document must describe the manifest the assembler accepts, not the older
// renderer-neutral shape whose fields validation rejects outright.
assert.match(editManifestReference, /"variant_id"/);
assert.match(editManifestReference, /"segments"/);
assert.match(editManifestReference, /inputs_fingerprint/);
assert.doesNotMatch(editManifestReference, /"renderer"/);
assert.doesNotMatch(editManifestReference, /"timeline"/);
assert.doesNotMatch(editManifestReference, /idempotency_key/);

const openChatCutSkill = fs.readFileSync(
  path.join(sourceRoot, "edit-with-openchatcut", "SKILL.md"),
  "utf8",
);
// The editor route must keep the project's gates: a session lifecycle the user
// approves, and an export that only enters the project through adoption.
assert.match(openChatCutSkill, /begin_edit_session/);
assert.match(openChatCutSkill, /review_edit_session/);
assert.match(openChatCutSkill, /approvalMode/);
assert.match(openChatCutSkill, /openchatcut status/);
assert.match(openChatCutSkill, /adopt-master/);
assert.match(openChatCutSkill, /analyse-master\.mjs/);
assert.match(openChatCutSkill, /Never paste the token/);
const openChatCutReference = fs.readFileSync(
  path.join(sourceRoot, "edit-with-openchatcut", "references", "openchatcut-session.md"),
  "utf8",
);
assert.match(openChatCutReference, /import_media/);
assert.match(openChatCutReference, /finalize_uploaded_asset/);
assert.match(openChatCutReference, /submit_render_job/);
assert.match(openChatCutReference, /track_export/);
assert.match(openChatCutReference, /adopted-master\/1/);
const projectMcpConfig = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
assert.equal(projectMcpConfig.mcpServers.openchatcut.type, "http");
assert.match(projectMcpConfig.mcpServers.openchatcut.url, /\/api\/external-mcp\/mcp$/);
assert.match(projectMcpConfig.mcpServers.openchatcut.headers.Authorization, /^Bearer \$\{OPENCHATCUT_MCP_TOKEN/);

const agentsInstructions = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
assert.match(agentsInstructions, /\$edit-with-openchatcut/);
assert.match(agentsInstructions, /adopt-master/);
assert.match(agentsInstructions, /Kling O3.*provider\/catalog alias/);
assert.match(agentsInstructions, /\$produce-short-video/);
assert.match(agentsInstructions, /scripts\/init-production\.mjs/);
assert.match(agentsInstructions, /metadata\.production/);
assert.match(agentsInstructions, /Не используй общий `artifacts\/jobs`/);
assert.match(agentsInstructions, /не применяй к ним `git clean`/);
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
assert.doesNotMatch(gitignore, /^\/clients\/$/m);
assert.match(gitignore, /^\/projects\/$/m);
assert.match(gitignore, /^\/artifacts\/$/m);
assert.match(gitignore, /^\/characters\/$/m);
assert.equal(
  agentsInstructions,
  fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"),
  "CLAUDE.md must stay identical to AGENTS.md",
);

testSyncFailureModes();

console.log(`All ${skills.length} skill(s) passed structural and regression checks.`);
