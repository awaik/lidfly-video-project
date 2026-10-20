import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectImage, formatAspectRatio } from "../src/domain/reference-asset.mjs";
import { buildEvolinkPayload, describeModeCapacity } from "../src/providers/evolink/model-catalog.mjs";
import { normalizeVideoRequest } from "../src/domain/video-request.mjs";
import {
  addReferenceAsset,
  retireReferenceAsset,
  checkReferenceAssets,
  listReferenceAssets,
} from "../src/workflows/asset-registry.mjs";
import { bootstrapProduction } from "../src/workflows/production-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(root, "src", "cli.mjs");

function pngBytes(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

function jpegBytes(width, height) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const app0 = Buffer.concat([
    Buffer.from("JFIF\0", "latin1"),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([header, app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpBytes(width, height) {
  const buffer = Buffer.alloc(32);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(24, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8L", 12, "latin1");
  buffer.writeUInt32LE(12, 16);
  buffer[20] = 0x2f;
  buffer.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buffer;
}

async function projectWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lidfly-assets-"));
  const context = await bootstrapProduction({
    workspaceRoot,
    clientId: "acme",
    clientName: "Acme",
    videoNumber: 1,
    mode: "new",
  });
  const incoming = join(workspaceRoot, "incoming");
  await mkdir(incoming, { recursive: true });
  return { workspaceRoot, projectRoot: context.project_root, incoming };
}

async function writeSource(incoming, name, contents) {
  const path = join(incoming, name);
  await writeFile(path, contents);
  return path;
}

async function addPhoto(workspace, { name, assetId, role = "identity", bytes, rights = "approved" }) {
  const filePath = await writeSource(workspace.incoming, name, bytes);
  return addReferenceAsset({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    filePath,
    assetId,
    role,
    rightsStatus: rights,
  });
}

test("image identity comes from magic bytes, not the extension the user happened to send", () => {
  assert.deepEqual(detectImage(pngBytes(1080, 1920)), {
    format: "png",
    width: 1080,
    height: 1920,
    extension: ".png",
    mime_type: "image/png",
  });
  assert.equal(detectImage(jpegBytes(1200, 1600)).format, "jpeg");
  assert.equal(detectImage(jpegBytes(1200, 1600)).width, 1200);
  assert.equal(detectImage(webpBytes(720, 1280)).height, 1280);

  const heicLike = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic", "latin1"),
    Buffer.alloc(64),
  ]);
  assert.equal(detectImage(heicLike), null);
  assert.equal(detectImage(Buffer.from("%PDF-1.7\n%not an image")), null);
  assert.equal(formatAspectRatio(1080, 1920), "9:16");
});

test("ingesting a reference copies it without touching the user's original", async () => {
  const workspace = await projectWorkspace();
  const source = await writeSource(workspace.incoming, "hero.jpg", jpegBytes(1080, 1440));
  const before = await stat(source);

  const result = await addReferenceAsset({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    filePath: source,
    assetId: "hero-front",
    role: "identity",
    rightsStatus: "approved",
    note: "прислано пользователем",
  });

  assert.equal(result.reused, false);
  assert.equal(result.asset.path, "assets/originals/hero-front.jpg");
  assert.equal(result.asset.width, 1080);
  assert.equal(result.asset.aspect_ratio, "3:4");
  assert.equal(result.asset.rights_status, "approved");
  assert.match(result.asset.sha256, /^[a-f0-9]{64}$/);

  const after = await stat(source);
  assert.equal(after.size, before.size);
  const copied = await readFile(
    join(workspace.workspaceRoot, workspace.projectRoot, result.asset.path),
  );
  assert.deepEqual(copied, await readFile(source));

  const registry = JSON.parse(
    await readFile(join(workspace.workspaceRoot, workspace.projectRoot, "assets.json"), "utf8"),
  );
  assert.equal(registry.project_id, "ACME-V001");
  assert.equal(registry.policy.originals_immutable, true);
  assert.equal(registry.assets.length, 1);
});

test("a stored reference is never overwritten and re-adding the same file is idempotent", async () => {
  const workspace = await projectWorkspace();
  const first = await addPhoto(workspace, {
    name: "hero-1.png",
    assetId: "hero-front",
    bytes: pngBytes(1080, 1920),
  });

  const repeat = await addPhoto(workspace, {
    name: "hero-1-copy.png",
    assetId: "hero-front",
    bytes: pngBytes(1080, 1920),
  });
  assert.equal(repeat.reused, true);
  assert.equal(repeat.asset.sha256, first.asset.sha256);

  await assert.rejects(
    addPhoto(workspace, {
      name: "someone-else.png",
      assetId: "hero-front",
      bytes: pngBytes(720, 1280),
    }),
    /already holds different content/,
  );

  const stored = await readFile(
    join(workspace.workspaceRoot, workspace.projectRoot, first.asset.path),
  );
  assert.deepEqual(detectImage(stored), detectImage(pngBytes(1080, 1920)));

  const listed = await listReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
  });
  assert.equal(listed.assets.length, 1);
});

test("an idempotent add fails closed when the registered original is missing", async () => {
  const workspace = await projectWorkspace();
  const first = await addPhoto(workspace, {
    name: "hero.png",
    assetId: "hero-front",
    bytes: pngBytes(1080, 1920),
  });
  const storedPath = join(workspace.workspaceRoot, workspace.projectRoot, first.asset.path);
  await rename(storedPath, `${storedPath}.preserved-missing`);

  await assert.rejects(
    addPhoto(workspace, {
      name: "hero-copy.png",
      assetId: "hero-front",
      bytes: pngBytes(1080, 1920),
    }),
    /Registered original is missing/,
  );
});

test("parallel asset additions preserve every manifest record", async () => {
  const workspace = await projectWorkspace();
  const additions = Array.from({ length: 8 }, (_, index) =>
    addPhoto(workspace, {
      name: `parallel-${index + 1}.png`,
      assetId: `parallel-${index + 1}`,
      bytes: pngBytes(1080 + index, 1920),
    }),
  );
  await Promise.all(additions);

  const listed = await listReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
  });
  assert.deepEqual(
    listed.assets.map((asset) => asset.asset_id),
    Array.from({ length: 8 }, (_, index) => `parallel-${index + 1}`),
  );
  assert.equal(
    (await readdir(join(workspace.workspaceRoot, workspace.projectRoot, "assets/originals"))).length,
    8,
  );
  assert.doesNotMatch(
    (await readdir(join(workspace.workspaceRoot, workspace.projectRoot))).join("\n"),
    /assets\.json\.lock/,
  );
});

test("a mislabelled or unsupported file is rejected before it can reach a provider", async () => {
  const workspace = await projectWorkspace();
  const result = await addPhoto(workspace, {
    name: "photo.jpg",
    assetId: "hero-front",
    bytes: pngBytes(1080, 1920),
  });
  assert.equal(result.asset.format, "png");
  assert.equal(result.asset.path, "assets/originals/hero-front.png");

  await assert.rejects(
    addPhoto(workspace, {
      name: "clip.mov",
      assetId: "clip",
      role: "reference_image",
      bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ", "latin1")]),
    }),
    /Unsupported reference format/,
  );
});

test("check refuses a photo set that exceeds the mode capacity instead of failing at submit", async () => {
  const workspace = await projectWorkspace();
  for (let index = 1; index <= 10; index += 1) {
    await addPhoto(workspace, {
      name: `sheet-${index}.png`,
      assetId: `sheet-${index}`,
      role: "reference_image",
      bytes: pngBytes(1080 + index, 1920),
    });
  }

  const overflow = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "seedance-2.0",
    mode: "reference_to_video",
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.capacity.images, 9);
  assert.ok(overflow.findings.some((finding) => finding.code === "too_many_images"));

  const withinLimit = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "seedance-2.0",
    mode: "reference_to_video",
    assetIds: ["sheet-1", "sheet-2", "sheet-3"],
  });
  assert.equal(withinLimit.ok, true);
  assert.equal(withinLimit.selected_assets.length, 3);
});

test("check reports Kling limits, format gaps, and the missing video reference", async () => {
  const workspace = await projectWorkspace();
  for (let index = 1; index <= 5; index += 1) {
    await addPhoto(workspace, {
      name: `ref-${index}.png`,
      assetId: `ref-${index}`,
      role: "reference_image",
      bytes: pngBytes(1080, 1920),
    });
  }

  const referenceMode = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "kling-o3",
    mode: "reference_to_video",
  });
  assert.equal(referenceMode.ok, false);
  assert.ok(referenceMode.findings.some((finding) => finding.code === "video_reference_required"));
  assert.ok(referenceMode.findings.some((finding) => finding.code === "too_many_images"));

  await assert.rejects(
    checkReferenceAssets({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: workspace.projectRoot,
      model: "kling-o3",
      mode: "reference_to_video",
      assetIds: ["ref-1"],
      videoUrl: "https://example.com/reference.mp4",
    }),
    /--video-url and --video-rights must be provided together/,
  );
  await assert.rejects(
    checkReferenceAssets({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: workspace.projectRoot,
      model: "kling-o3",
      mode: "reference_to_video",
      assetIds: ["ref-1"],
      videoUrl: "http://example.com/reference.mp4",
      videoRightsStatus: "approved",
    }),
    /HTTPS/,
  );

  for (const mode of ["reference_to_video", "video_edit"]) {
    const withVideo = await checkReferenceAssets({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: workspace.projectRoot,
      model: "kling-o3",
      mode,
      assetIds: ["ref-1", "ref-2", "ref-3", "ref-4"],
      videoUrl: "https://example.com/reference.mp4",
      videoRightsStatus: "approved",
    });
    assert.equal(withVideo.ok, true, `${mode} should pass with its required HTTPS video URL`);
    assert.equal(
      withVideo.video_reference.role,
      mode === "video_edit" ? "source_video" : "reference_video",
    );
    assert.ok(!withVideo.findings.some((finding) => finding.code === "video_reference_required"));
  }

  await addPhoto(workspace, {
    name: "style.webp",
    assetId: "style-plate",
    role: "style",
    bytes: webpBytes(1080, 1920),
  });
  const klingWebp = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "kling-o3",
    mode: "image_to_video",
    assetIds: ["style-plate"],
  });
  assert.equal(klingWebp.ok, false);
  assert.ok(klingWebp.findings.some((finding) => finding.code === "unsupported_format"));

  const seedanceWebp = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "seedance-2.0",
    mode: "reference_to_video",
    assetIds: ["style-plate"],
  });
  assert.equal(seedanceWebp.ok, true);
});

test("check warns about small or wrongly framed photos without blocking them", async () => {
  const workspace = await projectWorkspace();
  await addPhoto(workspace, {
    name: "tiny.png",
    assetId: "hero-tiny",
    role: "start_frame",
    bytes: pngBytes(480, 640),
  });

  const report = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "kling-v3",
    mode: "image_to_video",
    aspectRatio: "9:16",
  });
  assert.equal(report.ok, true);
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("low_resolution"));
  assert.ok(codes.includes("aspect_ratio_mismatch"));
});

test("Seedance 2.5 adaptive image mode warns when a source will produce horizontal output", async () => {
  const workspace = await projectWorkspace();
  await addPhoto(workspace, {
    name: "horizontal.png",
    assetId: "horizontal-start",
    role: "start_frame",
    bytes: pngBytes(1920, 1080),
  });

  const report = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    mode: "image_to_video",
  });

  assert.equal(report.model, "seedance-2.5");
  assert.equal(report.aspect_ratio, "adaptive");
  assert.equal(report.ok, true);
  assert.ok(!report.findings.some((finding) => finding.code === "capacity_conflict"));
  const warning = report.findings.find((finding) => finding.code === "adaptive_aspect_ratio");
  assert.equal(warning?.level, "warning");
  assert.match(warning?.message ?? "", /16:9.*9:16/);
});

test("identity references marked not_required produce a rights warning", async () => {
  const workspace = await projectWorkspace();
  const result = await addPhoto(workspace, {
    name: "identity.png",
    assetId: "identity-unconfirmed",
    bytes: pngBytes(1080, 1920),
    rights: "not_required",
  });
  assert.ok(result.findings.some((finding) => finding.code === "identity_rights_unconfirmed"));
});

test("a mode that takes no images returns one unambiguous verdict", async () => {
  const workspace = await projectWorkspace();
  await addPhoto(workspace, {
    name: "hero.png",
    assetId: "hero-front",
    bytes: pngBytes(1080, 1920),
  });

  const report = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "kling-v3",
    mode: "text_to_video",
  });
  assert.equal(report.ok, false);
  assert.equal(report.capacity.images, 0);
  const blockers = report.findings.filter((finding) => finding.level === "blocker");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "references_unsupported");

  const empty = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    model: "kling-v3",
    mode: "text_to_video",
    assetIds: [],
  });
  assert.equal(empty.ok, true);
});

test("declared image capacity matches the payload builder for every supported mode", () => {
  const modes = [
    ["seedance-2.5", "text_to_video"],
    ["seedance-2.5", "image_to_video"],
    ["seedance-2.5", "reference_to_video"],
    ["seedance-2.5", "video_edit"],
    ["seedance-2.5", "video_extend"],
    ["seedance-2.0", "text_to_video"],
    ["seedance-2.0", "image_to_video"],
    ["seedance-2.0", "reference_to_video"],
    ["kling-o3", "text_to_video"],
    ["kling-o3", "image_to_video"],
    ["kling-o3", "reference_to_video"],
    ["kling-o3", "video_edit"],
    ["kling-v3", "text_to_video"],
    ["kling-v3", "image_to_video"],
  ];
  const reference = (index, role = "reference_image") => ({
    asset_id: `ref-${index}`,
    role,
    url: `https://example.invalid/ref-${index}`,
    rights_status: "approved",
  });
  const build = (model, mode, imageCount) => {
    const capacity = describeModeCapacity(model, mode);
    const references = capacity.image_roles
      ? Array.from({ length: imageCount }, (_, index) =>
          reference(index, capacity.image_roles[index] ?? "reference_image"),
        )
      : Array.from({ length: imageCount }, (_, index) => reference(index));
    const videoRole = capacity.required_roles.find((role) =>
      ["reference_video", "source_video"].includes(role),
    );
    if (videoRole) references.push(reference("video", videoRole));
    return buildEvolinkPayload(
      normalizeVideoRequest({
        shot_id: "S001",
        take_id: "T001",
        model,
        mode,
        prompt: "capacity probe",
        generate_audio: false,
        references,
      }),
    );
  };

  for (const [model, mode] of modes) {
    const capacity = describeModeCapacity(model, mode);
    assert.doesNotThrow(() => build(model, mode, capacity.images), `${model}/${mode} max`);
    assert.throws(() => build(model, mode, capacity.images + 1), `${model}/${mode} overflow`);
  }

  const frozen = describeModeCapacity("kling-o3", "video_edit");
  assert.throws(() => frozen.required_roles.push("reference_video"), TypeError);
  assert.deepEqual(describeModeCapacity("kling-o3", "video_edit").required_roles, ["source_video"]);
  assert.throws(() => describeModeCapacity("kling-v3", "video_edit"), /does not support mode/);
});

test("assets CLI ingests a photo and exits non-zero on a failed capacity check", async () => {
  const workspace = await projectWorkspace();
  const source = await writeSource(workspace.incoming, "hero.png", pngBytes(1080, 1920));

  const added = await execFileAsync(process.execPath, [
    cliPath,
    "assets",
    "add",
    "--workspace-root",
    workspace.workspaceRoot,
    "--project",
    workspace.projectRoot,
    "--file",
    source,
    "--asset-id",
    "hero-front",
    "--role",
    "identity",
    "--rights",
    "approved",
  ]);
  assert.equal(JSON.parse(added.stdout).asset.asset_id, "hero-front");

  const originals = await readdir(
    join(workspace.workspaceRoot, workspace.projectRoot, "assets", "originals"),
  );
  assert.deepEqual(originals, ["hero-front.png"]);

  const failure = await execFileAsync(process.execPath, [
    cliPath,
    "assets",
    "check",
    "--workspace-root",
    workspace.workspaceRoot,
    "--project",
    workspace.projectRoot,
    "--model",
    "kling-o3",
    "--mode",
    "video_edit",
  ]).catch((error) => error);
  assert.equal(failure.code, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "video_reference_required"));

  const success = await execFileAsync(process.execPath, [
    cliPath,
    "assets",
    "check",
    "--workspace-root",
    workspace.workspaceRoot,
    "--project",
    workspace.projectRoot,
    "--model",
    "kling-o3",
    "--mode",
    "video_edit",
    "--video-url",
    "https://example.com/source.mp4",
    "--video-rights",
    "approved",
  ]);
  assert.equal(JSON.parse(success.stdout).ok, true);
});

test("a project root outside the workspace is refused", async () => {
  const workspace = await projectWorkspace();
  await assert.rejects(
    listReferenceAssets({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: "../../etc",
    }),
    /escapes the workspace/,
  );
});

test("asset registry rejects a managed project path that escapes through a symlink", async () => {
  const managedWorkspace = await mkdtemp(join(tmpdir(), "lidfly-assets-symlink-"));
  const outside = await projectWorkspace();
  await symlink(join(outside.workspaceRoot, "projects"), join(managedWorkspace, "projects"));
  const source = await writeSource(outside.incoming, "outside.png", pngBytes(1080, 1920));

  await assert.rejects(
    addReferenceAsset({
      workspaceRoot: managedWorkspace,
      projectRoot: outside.projectRoot,
      filePath: source,
      assetId: "must-stay-inside",
      role: "identity",
      rightsStatus: "approved",
    }),
    /symlink outside workspace_root/,
  );
  await assert.rejects(
    stat(join(outside.workspaceRoot, outside.projectRoot, "assets/originals/must-stay-inside.png")),
    /ENOENT/,
  );
});

test("non-assets commands reject stray positional arguments", async () => {
  const failure = await execFileAsync(process.execPath, [cliPath, "models", "junk"]).catch(
    (error) => error,
  );
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Unexpected argument: junk/);
});

test("retiring an asset is a note in the registry, never a deleted file", async () => {
  const workspace = await projectWorkspace();
  const bytes = pngBytes(1200, 1600);
  await addPhoto(workspace, { name: "keeper.png", assetId: "keeper", bytes });
  await addPhoto(workspace, { name: "spare.png", assetId: "spare", role: "environment", bytes });

  const retired = await retireReferenceAsset({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    assetId: "spare",
    status: "superseded",
    supersededBy: "keeper",
    note: "побайтный дубликат keeper",
  });
  assert.equal(retired.asset.status, "superseded");
  assert.equal(retired.previous_status, "active");

  // The ingested original is still exactly where ingestion put it.
  const original = join(workspace.workspaceRoot, workspace.projectRoot, retired.asset.path);
  assert.equal((await stat(original)).isFile(), true);
});

test("a retired asset leaves the capacity check and stops nagging about duplicates", async () => {
  const workspace = await projectWorkspace();
  const bytes = pngBytes(1200, 1600);
  await addPhoto(workspace, { name: "keeper.png", assetId: "keeper", bytes });
  await addPhoto(workspace, { name: "spare.png", assetId: "spare", role: "environment", bytes });
  const shared = {
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    mode: "reference_to_video",
  };

  const before = await checkReferenceAssets(shared);
  assert.ok(before.findings.some((finding) => finding.code === "duplicate_content"));

  await retireReferenceAsset({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    assetId: "spare",
    status: "superseded",
    supersededBy: "keeper",
    note: "дубликат",
  });

  const after = await checkReferenceAssets(shared);
  assert.equal(after.selected_assets.length, 1);
  assert.ok(!after.findings.some((finding) => finding.code === "duplicate_content"));

  // Asking for it by name is refused, so it cannot slip back in by accident.
  const explicit = await checkReferenceAssets({ ...shared, assetIds: ["spare"] });
  assert.equal(explicit.ok, false);
  assert.ok(explicit.findings.some((finding) => finding.code === "retired_asset_requested"));
});

test("retiring without a reason is refused", async () => {
  const workspace = await projectWorkspace();
  await addPhoto(workspace, { name: "solo.png", assetId: "solo", bytes: pngBytes(1200, 1600) });
  await assert.rejects(
    retireReferenceAsset({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: workspace.projectRoot,
      assetId: "solo",
      status: "unused",
    }),
    /--note is required/,
  );
});

test("superseded_by must point at an asset that is still in use", async () => {
  const workspace = await projectWorkspace();
  const bytes = pngBytes(1200, 1600);
  await addPhoto(workspace, { name: "a.png", assetId: "first", bytes });
  await addPhoto(workspace, { name: "b.png", assetId: "second", role: "environment", bytes: pngBytes(1100, 1500) });

  await assert.rejects(
    retireReferenceAsset({
      workspaceRoot: workspace.workspaceRoot,
      projectRoot: workspace.projectRoot,
      assetId: "first",
      status: "superseded",
      supersededBy: "ghost",
      note: "заменён",
    }),
    /is not in the registry/,
  );
});

/** The delivery shape the project actually froze, written where the checker looks for it. */
async function writeShotPlanTarget(workspace, aspectRatio) {
  const briefRoot = join(workspace.workspaceRoot, workspace.projectRoot, "brief");
  await mkdir(briefRoot, { recursive: true });
  await writeFile(
    join(briefRoot, "shotplan.json"),
    JSON.stringify({ project_id: "ACME-V001", status: "frozen", target: { aspect_ratio: aspectRatio } }),
    "utf8",
  );
}

test("a landscape project judges its references against 16:9, not against a default nobody chose", async () => {
  const workspace = await projectWorkspace();
  await writeShotPlanTarget(workspace, "16:9");
  await addPhoto(workspace, {
    name: "horizontal.png",
    assetId: "horizontal-start",
    role: "start_frame",
    bytes: pngBytes(1920, 1080),
  });

  const adaptive = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    mode: "image_to_video",
  });
  assert.equal(adaptive.aspect_ratio, "adaptive");
  assert.equal(adaptive.aspect_ratio_source, "shot_plan");
  assert.ok(
    !adaptive.findings.some((finding) => finding.code === "adaptive_aspect_ratio"),
    "a 16:9 source in a 16:9 project is exactly what was asked for",
  );

  const explicit = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    mode: "reference_to_video",
    aspectRatio: "9:16",
  });
  assert.equal(explicit.aspect_ratio_source, "explicit", "the flag still wins over the plan");
  assert.equal(
    explicit.findings.find((finding) => finding.code === "aspect_ratio_mismatch")?.level,
    "warning",
  );
});

test("without a shot plan the checker says so instead of pretending 9:16 was chosen", async () => {
  const workspace = await projectWorkspace();
  await addPhoto(workspace, {
    name: "horizontal.png",
    assetId: "horizontal-start",
    role: "start_frame",
    bytes: pngBytes(1920, 1080),
  });

  const report = await checkReferenceAssets({
    workspaceRoot: workspace.workspaceRoot,
    projectRoot: workspace.projectRoot,
    mode: "image_to_video",
  });
  assert.equal(report.aspect_ratio_source, "default");
  assert.match(
    report.findings.find((finding) => finding.code === "adaptive_aspect_ratio")?.message ?? "",
    /а не целевые 9:16/,
  );
});
