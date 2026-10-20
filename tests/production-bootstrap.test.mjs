import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  MAX_VIDEO_NUMBER,
  assertClientIdentity,
  clientNameCaseWarning,
  assertProjectIdentity,
  createClientManifest,
  createProjectManifest,
  formatProjectId,
  formatVideoDirectory,
  normalizeClientId,
  normalizeVideoNumber,
  validateClientManifest,
  validateProjectManifest,
} from "../src/domain/production-context.mjs";
import {
  bootstrapProduction,
  productionMetadata,
} from "../src/workflows/production-bootstrap.mjs";
import { normalizeVideoRequest } from "../src/domain/video-request.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(root, "scripts", "init-production.mjs");
const fixedNow = new Date("2026-08-05T09:00:00.000Z");

async function workspace(prefix = "lidfly-production-") {
  return mkdtemp(join(tmpdir(), prefix));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function storage(clientId, videoNumber, projectRoot = null) {
  const videoDirectory = formatVideoDirectory(videoNumber);
  return {
    mode: projectRoot ? "legacy_alias" : "standard",
    project_root: projectRoot ?? `projects/${clientId}/${videoDirectory}`,
    jobs_root: `artifacts/${clientId}/${videoDirectory}/jobs`,
    audio_root: `artifacts/${clientId}/${videoDirectory}/audio`,
    masters_root: `artifacts/${clientId}/${videoDirectory}/masters`,
  };
}

test("production identifiers are normalized without accepting Unicode or traversal", () => {
  assert.equal(normalizeClientId("acme"), "acme");
  assert.equal(normalizeClientId("amix-2"), "amix-2");
  for (const invalid of ["Acme", "акме", "../acme", "acme/one", "a--b", "-a", "a-", ""]) {
    assert.throws(() => normalizeClientId(invalid), /client_id/);
  }
  assert.throws(() => normalizeClientId("a".repeat(65)), /1-64/);

  assert.equal(normalizeVideoNumber("7"), 7);
  assert.equal(normalizeVideoNumber(MAX_VIDEO_NUMBER), MAX_VIDEO_NUMBER);
  for (const invalid of [0, -1, 1.5, MAX_VIDEO_NUMBER + 1, "١", "1.0", "../1"]) {
    assert.throws(() => normalizeVideoNumber(invalid), /video_number/);
  }
  assert.equal(formatVideoDirectory(1), "V001");
  assert.equal(formatVideoDirectory(1000), "V1000");
  assert.equal(formatProjectId("acme", 1), "ACME-V001");
  assert.equal(formatProjectId("amix", 7), "AMIX-V007");
});

test("client and project manifests validate immutable production identity", () => {
  const client = createClientManifest({
    clientId: "acme",
    clientName: "Acme",
    createdAt: fixedNow.toISOString(),
  });
  assert.equal(validateClientManifest(client), client);
  assert.equal(assertClientIdentity(client, { clientId: "acme", clientName: "Acme" }), client);
  // Same name in a different capitalisation is the same client: it is accepted
  // and reported, while the stored spelling stays authoritative.
  assert.equal(assertClientIdentity(client, { clientId: "acme", clientName: "ACME" }), client);
  assert.equal(clientNameCaseWarning(client, "Acme"), null);
  assert.match(clientNameCaseWarning(client, "ACME"), /differs only in case: stored Acme, requested ACME/);
  assert.equal(clientNameCaseWarning(client, "Aurora"), null);
  assert.throws(
    () => assertClientIdentity(client, { clientId: "acme", clientName: "Aurora" }),
    /display name conflict/,
  );

  const project = createProjectManifest({
    clientId: "acme",
    videoNumber: 1,
    title: "Видео №1",
    createdAt: fixedNow.toISOString(),
    storage: storage("acme", 1),
  });
  assert.equal(validateProjectManifest(project), project);
  assert.equal(
    assertProjectIdentity(project, {
      clientId: "acme",
      projectId: "ACME-V001",
      videoNumber: 1,
    }),
    project,
  );
  assert.throws(
    () => validateProjectManifest({ ...project, schema_version: 2 }),
    /schema_version/,
  );
  assert.throws(
    () => validateProjectManifest({ ...project, client_id: "amix" }),
    /project_id does not match/,
  );
  assert.throws(
    () => createProjectManifest({
      clientId: "acme",
      videoNumber: 1,
      title: "signed URL: https://example.test/file?token=secret",
      createdAt: fixedNow.toISOString(),
      storage: storage("acme", 1),
    }),
    /tokens, keys, cookies, or signed URLs/,
  );
  assert.throws(
    () => createClientManifest({
      clientId: "acme",
      clientName: "Acme",
      createdAt: "2026-02-31T00:00:00.000Z",
    }),
    /ISO 8601/,
  );
});

test("approval accepts an optional audit trail without breaking existing manifests", () => {
  const project = createProjectManifest({
    clientId: "acme",
    videoNumber: 1,
    title: "Видео №1",
    createdAt: fixedNow.toISOString(),
    storage: storage("acme", 1),
  });

  // Manifests written before the audit fields existed stay valid.
  assert.deepEqual(Object.keys(project.approval), ["paid_generation", "max_total_cost"]);
  assert.equal(validateProjectManifest(project), project);

  const audited = {
    ...project,
    approval: {
      paid_generation: true,
      max_total_cost: 9,
      approved_by: "user",
      approved_at: fixedNow.toISOString(),
      note: "бюджет подтверждён в диалоге",
    },
  };
  assert.equal(validateProjectManifest(audited), audited);

  // A partial audit trail is allowed; each field is still validated on its own.
  assert.equal(
    validateProjectManifest({
      ...project,
      approval: { paid_generation: true, max_total_cost: null, approved_by: "user" },
    }).approval.approved_by,
    "user",
  );
  assert.throws(
    () => validateProjectManifest({
      ...project,
      approval: { ...audited.approval, approved_at: "2026-08-14" },
    }),
    /approved_at must be an ISO 8601 UTC timestamp/,
  );
  assert.throws(
    () => validateProjectManifest({
      ...project,
      approval: { ...audited.approval, note: "api_key: sk-0123456789abcdef0123" },
    }),
    /tokens, keys, cookies, or signed URLs/,
  );
  // Unknown fields are still rejected — the schema stayed closed.
  assert.throws(
    () => validateProjectManifest({
      ...project,
      approval: { ...project.approval, budget_override: true },
    }),
    /unsupported field: budget_override/,
  );
});

test("a new exact project creates isolated local manifests and artifact roots", async () => {
  const workspaceRoot = await workspace();
  const context = await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    clientName: "AMIX",
    videoNumber: 7,
    mode: "ensure",
    now: fixedNow,
  });

  assert.deepEqual(context, {
    schema_version: 1,
    action: "created",
    client_id: "amix",
    project_id: "AMIX-V007",
    video_number: 7,
    project_manifest_path: "projects/amix/V007/project.json",
    project_root: "projects/amix/V007",
    jobs_root: "artifacts/amix/V007/jobs",
    audio_root: "artifacts/amix/V007/audio",
    masters_root: "artifacts/amix/V007/masters",
  });
  const client = await readJson(join(workspaceRoot, "projects/amix/client.json"));
  const project = await readJson(join(workspaceRoot, context.project_manifest_path));
  const variants = await readJson(join(workspaceRoot, context.project_root, "variants.json"));
  assert.equal(client.storage_policy, "local_only");
  assert.equal(project.approval.paid_generation, false);
  assert.equal(project.approval.max_total_cost, null);
  assert.equal(project.rights.status, "pending");
  assert.equal(variants.project_id, "AMIX-V007");
  assert.equal(variants.versioning_policy.monotonic, true);
  assert.equal(variants.versioning_policy.reuse_forbidden, true);
  for (const directory of [
    "projects/amix/brand",
    "projects/amix/V007/brief",
    "projects/amix/V007/assets",
    "projects/amix/V007/requests",
    "projects/amix/V007/reviews",
    "projects/amix/V007/edits",
    context.jobs_root,
    context.audio_root,
    context.masters_root,
  ]) {
    assert.equal((await stat(join(workspaceRoot, directory))).isDirectory(), true, directory);
  }
  await assert.rejects(stat(join(workspaceRoot, "clients")), { code: "ENOENT" });
});

test("a differently capitalised client name warns instead of failing the bootstrap", async () => {
  const workspaceRoot = await workspace();
  await bootstrapProduction({
    workspaceRoot,
    clientId: "lidfly",
    clientName: "Lidfly",
    videoNumber: 1,
    mode: "ensure",
    title: "Видео №1",
    now: fixedNow,
  });

  // The real case that used to abort the bootstrap outright.
  const second = await bootstrapProduction({
    workspaceRoot,
    clientId: "lidfly",
    clientName: "LidFly",
    videoNumber: 2,
    mode: "ensure",
    title: "Видео №2",
    now: fixedNow,
  });

  assert.equal(second.project_id, "LIDFLY-V002");
  assert.match(
    second.warnings.find((warning) => warning.includes("differs only in case")),
    /stored Lidfly, requested LidFly/,
  );
  // The stored spelling wins: bootstrap never renames a client behind the user.
  assert.equal((await readJson(join(workspaceRoot, "projects/lidfly/client.json"))).display_name, "Lidfly");

  // A genuinely different name is still a hard conflict.
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "lidfly",
      clientName: "Lidly",
      videoNumber: 3,
      mode: "ensure",
      title: "Видео №3",
      now: fixedNow,
    }),
    /display name conflict/,
  );
});

test("ensure reuses a project without rewriting timestamps, title, or manifests", async () => {
  const workspaceRoot = await workspace();
  const first = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    mode: "ensure",
    title: "Original",
    now: fixedNow,
  });
  const clientPath = join(workspaceRoot, "projects/acme/client.json");
  const projectPath = join(workspaceRoot, first.project_manifest_path);
  const variantsPath = join(workspaceRoot, first.project_root, "variants.json");
  const before = await Promise.all(
    [clientPath, projectPath, variantsPath].map((filePath) => readFile(filePath, "utf8")),
  );

  const second = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    videoNumber: 1,
    mode: "ensure",
    title: "Must not replace Original",
    now: new Date("2026-08-06T09:00:00.000Z"),
  });
  const after = await Promise.all(
    [clientPath, projectPath, variantsPath].map((filePath) => readFile(filePath, "utf8")),
  );
  assert.equal(second.action, "reused");
  assert.deepEqual(after, before);
  assert.equal((await readJson(projectPath)).title, "Original");
});

test("an existing client can own multiple isolated exact projects", async () => {
  const workspaceRoot = await workspace();
  await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    clientName: "AMIX",
    videoNumber: 1,
    now: fixedNow,
  });
  const second = await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    videoNumber: 7,
    now: fixedNow,
  });
  assert.equal(second.project_id, "AMIX-V007");
  assert.equal(second.jobs_root, "artifacts/amix/V007/jobs");
  assert.notEqual(second.jobs_root, "artifacts/amix/V001/jobs");
});

test("client display names do not merge IDs or silently rename an existing client", async () => {
  const workspaceRoot = await workspace();
  const first = await bootstrapProduction({
    workspaceRoot,
    clientId: "brand-one",
    clientName: "Shared Display",
    videoNumber: 1,
    now: fixedNow,
  });
  const second = await bootstrapProduction({
    workspaceRoot,
    clientId: "brand-two",
    clientName: "Shared Display",
    videoNumber: 1,
    now: fixedNow,
  });
  assert.equal(first.project_id, "BRAND-ONE-V001");
  assert.equal(second.project_id, "BRAND-TWO-V001");
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "brand-one",
      clientName: "Renamed Display",
      videoNumber: 1,
    }),
    /display name conflict/,
  );
});

test("new conflicts and resume requires an existing exact project", async () => {
  const workspaceRoot = await workspace();
  await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    now: fixedNow,
  });
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      videoNumber: 1,
      mode: "new",
    }),
    /Project ACME-V001 already exists.*project\.json/,
  );
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      videoNumber: 2,
      mode: "resume",
    }),
    /Project ACME-V002 does not exist/,
  );
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      next: true,
      mode: "resume",
    }),
    /cannot be combined/,
  );
});

test("next allocates max plus one without filling gaps", async () => {
  const workspaceRoot = await workspace();
  await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    clientName: "AMIX",
    videoNumber: 1,
    now: fixedNow,
  });
  await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    videoNumber: 7,
    now: fixedNow,
  });
  const next = await bootstrapProduction({
    workspaceRoot,
    clientId: "amix",
    next: true,
    now: fixedNow,
  });
  assert.equal(next.video_number, 8);
  assert.equal(next.project_id, "AMIX-V008");
  assert.equal((await readJson(join(workspaceRoot, next.project_manifest_path))).title, "Видео №8");
});

test("parallel next allocations claim distinct monotonic project numbers", async () => {
  const workspaceRoot = await workspace("lidfly-production-concurrent-");
  const contexts = await Promise.all(
    Array.from({ length: 6 }, async () =>
      JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [
              cliPath,
              "--workspace-root",
              workspaceRoot,
              "--client-id",
              "amix",
              "--client-name",
              "AMIX",
              "--next",
            ],
            { cwd: root },
          )
        ).stdout,
      ),
    ),
  );
  assert.deepEqual(
    contexts.map((context) => context.video_number).sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(new Set(contexts.map((context) => context.project_id)).size, 6);
});

test("foreign or stale staging entries are preserved and reported", async () => {
  const workspaceRoot = await workspace("lidfly-production-staging-");
  await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    now: fixedNow,
  });
  const stagingRoot = join(workspaceRoot, "projects/acme/.V002.bootstrap-old-run");
  await mkdir(stagingRoot);
  await writeFile(join(stagingRoot, "owner.txt"), "unknown owner\n", "utf8");

  const context = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    videoNumber: 1,
    mode: "ensure",
  });
  assert.deepEqual(context.warnings, [
    "Preserved staging entry requires review: projects/acme/.V002.bootstrap-old-run",
  ]);
  assert.equal((await stat(join(stagingRoot, "owner.txt"))).isFile(), true);
});

test("malformed managed directories and manifests fail closed", async () => {
  const missingManifestRoot = await workspace();
  await mkdir(join(missingManifestRoot, "projects/acme"), { recursive: true });
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot: missingManifestRoot,
      clientId: "acme",
      clientName: "Acme",
      videoNumber: 1,
    }),
    /Client manifest is missing/,
  );

  const projectConflictRoot = await workspace();
  await bootstrapProduction({
    workspaceRoot: projectConflictRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    now: fixedNow,
  });
  await mkdir(join(projectConflictRoot, "projects/acme/V002"));
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot: projectConflictRoot,
      clientId: "acme",
      videoNumber: 2,
    }),
    /Project manifest is missing/,
  );

  const corruptPath = join(projectConflictRoot, "projects/acme/V001/project.json");
  await writeFile(corruptPath, "{broken", "utf8");
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot: projectConflictRoot,
      clientId: "acme",
      videoNumber: 1,
    }),
    /invalid JSON/,
  );
});

test("legacy alias registration preserves the recognized source project", async () => {
  const workspaceRoot = await workspace("lidfly-production-legacy-");
  const legacyRoot = join(workspaceRoot, "projects/acme-legacy-project");
  await mkdir(legacyRoot, { recursive: true });
  const legacyVariants = {
    schema_version: 1,
    project_id: "acme-legacy-project",
    versioning_policy: {
      scheme: "B1, B2, B3, ...",
      monotonic: true,
      reuse_forbidden: true,
      retention: "keep everything",
    },
    variants: [{ variant_id: "B1", status: "retained" }],
  };
  const legacyPath = join(legacyRoot, "variants.json");
  await writeFile(legacyPath, `${JSON.stringify(legacyVariants, null, 2)}\n`, "utf8");
  const before = await readFile(legacyPath, "utf8");

  const created = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    mode: "ensure",
    legacyProjectRoot: "projects/acme-legacy-project",
    now: fixedNow,
  });
  assert.equal(created.action, "created");
  assert.equal(created.project_root, "projects/acme-legacy-project");
  assert.equal(created.project_manifest_path, "projects/acme/V001/project.json");
  const alias = await readJson(join(workspaceRoot, created.project_manifest_path));
  assert.equal(alias.storage.mode, "legacy_alias");
  assert.deepEqual(await readdir(join(workspaceRoot, "projects/acme/V001")), ["project.json"]);
  assert.equal(await readFile(legacyPath, "utf8"), before);

  const resumed = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    videoNumber: 1,
    mode: "resume",
  });
  assert.equal(resumed.action, "reused");
  assert.equal(resumed.project_root, "projects/acme-legacy-project");
});

test("legacy roots must be relative, inside the workspace, and recognizable", async () => {
  const workspaceRoot = await workspace();
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      clientName: "Acme",
      videoNumber: 1,
      legacyProjectRoot: "../outside",
    }),
    /relative workspace path/,
  );
  await mkdir(join(workspaceRoot, "legacy-empty"));
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      clientName: "Acme",
      videoNumber: 1,
      legacyProjectRoot: "legacy-empty",
    }),
    /no recognizable/,
  );
});

test("managed paths reject symlink escapes", async () => {
  const workspaceRoot = await workspace("lidfly-production-symlink-");
  const outsideRoot = await workspace("lidfly-production-outside-");
  await symlink(outsideRoot, join(workspaceRoot, "projects"));
  await assert.rejects(
    bootstrapProduction({
      workspaceRoot,
      clientId: "acme",
      clientName: "Acme",
      videoNumber: 1,
    }),
    /symlink outside workspace_root/,
  );
});

test("production metadata uses the existing request metadata extension point", () => {
  assert.deepEqual(
    productionMetadata({ client_id: "acme", project_id: "ACME-V001", video_number: 1 }),
    {
      production: {
        client_id: "acme",
        project_id: "ACME-V001",
        video_number: 1,
      },
    },
  );
  assert.throws(
    () => productionMetadata({ client_id: "acme", project_id: "AMIX-V001", video_number: 1 }),
    /project_id/,
  );

  const request = normalizeVideoRequest({
    shot_id: "S001",
    take_id: "T001",
    model: "kling-v3",
    metadata: {
      purpose: "test",
      ...productionMetadata({
        client_id: "acme",
        project_id: "ACME-V001",
        video_number: 1,
      }),
    },
  });
  assert.equal(request.metadata.purpose, "test");
  assert.equal(request.metadata.production.project_id, "ACME-V001");
  assert.throws(
    () => normalizeVideoRequest({ ...request, client_id: "acme" }),
    /unsupported field: client_id/,
  );
});

test("internal CLI emits stable JSON and diagnostics without loading provider code", async () => {
  const workspaceRoot = await workspace("lidfly-production-cli-");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "--workspace-root",
      workspaceRoot,
      "--client-id",
      "amix",
      "--client-name",
      "AMIX",
      "--video-number",
      "7",
      "--mode",
      "ensure",
    ],
    { cwd: root, env: { PATH: process.env.PATH } },
  );
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).project_id, "AMIX-V007");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliPath, "--workspace-root", workspaceRoot, "--client-id", "amix", "--next", "true"],
      { cwd: root },
    ),
    (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /--next does not accept a value/);
      return true;
    },
  );

  const workflowSource = await readFile(
    join(root, "src/workflows/production-bootstrap.mjs"),
    "utf8",
  );
  const cliSource = await readFile(cliPath, "utf8");
  assert.doesNotMatch(
    `${workflowSource}\n${cliSource}`,
    /providers\/|EVOLINK_API_KEY|KOMEND|loadEnvFile|fetch\s*\(/,
  );
});

test("bootstrap performs no network calls", async () => {
  const workspaceRoot = await workspace("lidfly-production-offline-");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be called");
  };
  try {
    const context = await bootstrapProduction({
      workspaceRoot,
      clientId: "offline",
      clientName: "Offline",
      videoNumber: 1,
      now: fixedNow,
    });
    assert.equal(context.project_id, "OFFLINE-V001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
