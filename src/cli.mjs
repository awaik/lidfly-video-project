#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "./config/env.mjs";
import { redact } from "./core/errors.mjs";
import { DEFAULT_VIDEO_MODEL } from "./domain/video-request.mjs";
import { EvolinkClient } from "./providers/evolink/client.mjs";
import { listEvolinkModels } from "./providers/evolink/model-catalog.mjs";
import {
  addReferenceAsset,
  retireReferenceAsset,
  checkReferenceAssets,
  listReferenceAssets,
} from "./workflows/asset-registry.mjs";
import { importBrowserTake } from "./workflows/browser-video.mjs";
import { adoptExternalMaster } from "./workflows/adopt-master.mjs";
import { assembleMaster } from "./workflows/assembly.mjs";
import { runDoctor } from "./workflows/doctor.mjs";
import {
  checkOpenChatCut,
  connectClaudeCode,
  importIntoOpenChatCut,
  installOpenChatCut,
  openOpenChatCut,
  renderInOpenChatCut,
  startOpenChatCut,
  stopOpenChatCut,
  upOpenChatCut,
} from "./workflows/openchatcut.mjs";
import { synthesizeJobNarration } from "./workflows/narration.mjs";
import { findJobs, prepareRetry } from "./workflows/retry.mjs";
import { latestSpeechVerification, verifyJobSpeech } from "./workflows/speech-verification.mjs";
import { planRequestDirectory, waitForJobsRoot } from "./workflows/batch.mjs";
import { extractJobFrames, prepareChainedRequest } from "./workflows/chain.mjs";
import { describeProjectBudget } from "./workflows/budget.mjs";
import { listProviderTasks, reconcileVideoJob } from "./workflows/reconcile.mjs";
import { detectJobSpeechSignal } from "./workflows/speech-likeness.mjs";
import {
  checkShotPlan,
  composeShotRequests,
  freezeShotPlan,
  initShotPlan,
  recordShotPlanReview,
  shotPlanStatus,
} from "./workflows/shot-plan.mjs";
import {
  planVideoJob,
  refreshVideoJob,
  submitVideoJob,
  waitForVideoJob,
} from "./workflows/video-job.mjs";

const SUBCOMMAND_COMMANDS = new Set(["assets", "script", "openchatcut"]);

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const tokens = [...rest];
  const subcommand =
    SUBCOMMAND_COMMANDS.has(command) && tokens[0] && !tokens[0].startsWith("--") ? tokens.shift() : null;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, subcommand, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value || value === true) throw new TypeError(`--${name.replaceAll("_", "-")} is required`);
  return String(value);
}

function booleanFlag(options, name) {
  const value = options[name];
  if (value === undefined) return false;
  if (value !== true) {
    throw new TypeError(`--${name.replaceAll("_", "-")} does not accept a value`);
  }
  return true;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(redact(value), null, 2)}\n`);
}

function help() {
  process.stdout.write(`LidFly API-first video CLI

Commands:
  models
  doctor
  assets add   [--workspace-root <path>] --project <projects/<client>/VNNN>
               --file <path> --asset-id <id>
               --role <identity|start_frame|...> --rights <approved|not_required> [--note <text>]
  assets list  [--workspace-root <path>] --project <projects/<client>/VNNN>
  assets retire [--workspace-root <path>] --project <projects/<client>/VNNN>
               --asset-id <id> --status <active|superseded|unused>
               [--superseded-by <id>] --note "<почему>"
  assets check [--workspace-root <path>] --project <projects/<client>/VNNN>
               [--model <model>] --mode <mode> [--video-url <https-url>]
               [--video-rights <approved|not_required>]
               [--assets <id,id,...>] [--aspect-ratio <ratio>] [--resolution 720p]
               (без --aspect-ratio берётся target.aspect_ratio из brief/shotplan.json)
  script init   [--workspace-root <path>] --project <projects/<client>/VNNN>
               --script <path> --duration-seconds <N> [--title <text>]
               [--aspect-ratio <9:16|16:9|1:1|4:3|3:4|21:9>] [--model seedance-2.5]
               [--resolution 720p]
               [--audio-mode <text>] [--adopt]
  script check  [--workspace-root <path>] --project <projects/<client>/VNNN>
  script review [--workspace-root <path>] --project <projects/<client>/VNNN> --record <path>
  script freeze [--workspace-root <path>] --project <projects/<client>/VNNN>
  script compose [--workspace-root <path>] --project <projects/<client>/VNNN>
               [--shot <id>] [--take-id T001] [--dry-run]
  script status [--workspace-root <path>] --project <projects/<client>/VNNN>
  budget --project <projects/<client>/VNNN> [--workspace-root <path>]
               [--jobs-root <path>] [--model seedance-2.5] [--resolution 720p]
  plan   --request <request.json> [--jobs-root artifacts/jobs]
  plan   --requests <directory> [--jobs-root artifacts/<client>/VNNN/jobs]
  submit --job <job-directory> --execute
  status --job <job-directory>
  wait   --job <job-directory> [--timeout-seconds 900] [--no-download]
  wait   --jobs-root <root> --all [--timeout-seconds 900] [--no-download]
  tasks  [--limit 20]
  reconcile --job <job-directory> [--limit 50] [--window-seconds 900]
               [--task-id <id>] [--adopt] [--release]
  retry  --job <job-directory> --change "<the single variable you are changing>"
               [--take-id <id>]
  jobs   --jobs-root <artifacts/<client>/VNNN/jobs> [--shot <id>] [--phase <phase>] [--latest]
  extract-frames --job <job-directory>
  chain  --from-job <job-directory> --request <new-request.json> --review <review.json>
               [--frame last|first]
  detect-speech --job <job-directory>
  verify-speech --job <job-directory>
  tts    --job <job-directory> [--native-audio-status <missing|unusable>] --execute
  assemble --manifest <edit-manifest.json> [--workspace-root <path>] [--force]
               [--require-review]
  browser-import --project <path> --request <browser-request.json>
                 --receipt <receipt.json> --file <downloaded.mp4>
  adopt-master --project <projects/<client>/VNNN> --variant <id>
               (--file <exported.mp4> | --url <http://localhost:5199/media/uploads/...>)
               [--timeline <read_timeline.json>] [--renderer openchatcut]
               [--renderer-project <id>] [--render-id <id>] [--note <text>]
               [--target-lufs -20,-16] [--workspace-root <path>]
  openchatcut status  [--workspace-root <path>]
  openchatcut install [--workspace-root <path>]
  openchatcut up      [--project-id <id>] [--open] [--no-wait] [--desktop]
               [--timeout-seconds 180] [--workspace-root <path>]
  openchatcut stop    [--workspace-root <path>]
  openchatcut open    [--project-id <id>]
  openchatcut start   [--workspace-root <path>] [--desktop]
  openchatcut connect [--workspace-root <path>]
  openchatcut import  --project-id <openchatcut project id> --files <take.mp4,take2.mp4,...>
               [--workspace-root <path>]
  openchatcut render  --project-id <openchatcut project id> [--name <file.mp4>]
               [--codec h264|vp8] [--resolution 480p|720p|1080p] [--fps 24]
               [--timeline-out <read_timeline.json>] [--timeout-seconds 900]
               [--save-to-media-pool] [--workspace-root <path>]

Assets commands are local only: they copy the user's originals into the project, never move,
overwrite, or delete them, and never contact a provider.
adopt-master copies an editor export into the project's masters root as the next version with
its sha256, origin and measured verification; the source file is never moved or altered.
openchatcut commands manage the OpenChatCut editor checkout next to this repository: status is
read-only, install clones/installs it, up starts it detached under Node 24 (idempotent) and waits
until its MCP endpoint answers, with --project-id also opening the project's tab and waiting for
the editor to register its tools; stop ends an editor that up started; open opens a tab; start
runs it in the foreground; connect registers its MCP endpoint in Claude Code's local scope.
The detached editor logs to .openchatcut-editor/editor.log. The MCP token is never printed.
openchatcut import/render act on a project that is open in a connected editor tab. They run the
editor's real-project tools in unattended (auto) edit sessions of their own: running the command
is the approval. import uploads reviewed takes (read, never moved) and checks the editor's
content hash against ours; render submits the active timeline, waits, and reports the file and
the timeline snapshot for adopt-master.
Paid video submission and TTS synthesis never run without --execute.
Komend TTS is allowed only after review marks native narration missing or unusable.
verify-speech transcribes a take and compares it with its scripted line; when a verification
report exists, tts reads the native-audio status from it instead of a hand-typed flag.
`);
}

async function jobsRootOfProject(projectRoot, workspaceRootOption) {
  const workspaceRoot = workspaceRootOption === undefined ? process.cwd() : String(workspaceRootOption);
  const manifest = JSON.parse(
    await readFile(resolve(workspaceRoot, projectRoot, "project.json"), "utf8"),
  );
  return resolve(workspaceRoot, manifest.storage.jobs_root);
}

async function scriptCommand(subcommand, options) {
  const workspace =
    options.workspace_root === undefined ? {} : { workspaceRoot: String(options.workspace_root) };
  const projectRoot = () => requireOption(options, "project");

  if (subcommand === "init") {
    output(
      await initShotPlan({
        ...workspace,
        projectRoot: projectRoot(),
        scriptPath: requireOption(options, "script"),
        durationSeconds: Number(requireOption(options, "duration_seconds")),
        ...(options.title === undefined ? {} : { title: String(options.title) }),
        ...(options.aspect_ratio === undefined ? {} : { aspectRatio: String(options.aspect_ratio) }),
        ...(options.model === undefined ? {} : { model: String(options.model) }),
        ...(options.resolution === undefined ? {} : { resolution: String(options.resolution) }),
        ...(options.audio_mode === undefined ? {} : { audioMode: String(options.audio_mode) }),
        adopt: booleanFlag(options, "adopt"),
      }),
    );
    return;
  }
  if (subcommand === "check") {
    const result = await checkShotPlan({ ...workspace, projectRoot: projectRoot() });
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (subcommand === "review") {
    output(
      await recordShotPlanReview({
        ...workspace,
        projectRoot: projectRoot(),
        recordPath: requireOption(options, "record"),
      }),
    );
    return;
  }
  if (subcommand === "freeze") {
    output(await freezeShotPlan({ ...workspace, projectRoot: projectRoot() }));
    return;
  }
  if (subcommand === "compose") {
    output(
      await composeShotRequests({
        ...workspace,
        projectRoot: projectRoot(),
        ...(options.shot === undefined ? {} : { shotId: String(options.shot) }),
        ...(options.take_id === undefined ? {} : { takeId: String(options.take_id) }),
        dryRun: booleanFlag(options, "dry_run"),
      }),
    );
    return;
  }
  if (subcommand === "status") {
    output(await shotPlanStatus({ ...workspace, projectRoot: projectRoot() }));
    return;
  }
  throw new TypeError(
    `Unknown script subcommand: ${subcommand ?? "(none)"}; use init, check, review, freeze, compose, or status`,
  );
}

async function assetsCommand(subcommand, options) {
  const workspace =
    options.workspace_root === undefined
      ? {}
      : { workspaceRoot: String(options.workspace_root) };
  if (subcommand === "add") {
    const result = await addReferenceAsset({
      ...workspace,
      projectRoot: requireOption(options, "project"),
      filePath: requireOption(options, "file"),
      assetId: requireOption(options, "asset_id"),
      role: requireOption(options, "role"),
      rightsStatus: requireOption(options, "rights"),
      ...(options.note === undefined ? {} : { note: String(options.note) }),
    });
    output(result);
    return;
  }
  if (subcommand === "list") {
    output(
      await listReferenceAssets({ ...workspace, projectRoot: requireOption(options, "project") }),
    );
    return;
  }
  if (subcommand === "check") {
    const result = await checkReferenceAssets({
      ...workspace,
      projectRoot: requireOption(options, "project"),
      ...(options.model === undefined ? {} : { model: requireOption(options, "model") }),
      mode: requireOption(options, "mode"),
      ...(options.assets === undefined
        ? {}
        : { assetIds: String(options.assets).split(",").map((value) => value.trim()).filter(Boolean) }),
      ...(options.aspect_ratio === undefined ? {} : { aspectRatio: String(options.aspect_ratio) }),
      ...(options.resolution === undefined ? {} : { resolution: String(options.resolution) }),
      ...(options.video_url === undefined ? {} : { videoUrl: String(options.video_url) }),
      ...(options.video_rights === undefined
        ? {}
        : { videoRightsStatus: String(options.video_rights) }),
    });
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (subcommand === "retire") {
    output(
      await retireReferenceAsset({
        ...workspace,
        projectRoot: requireOption(options, "project"),
        assetId: requireOption(options, "asset_id"),
        status: requireOption(options, "status"),
        ...(options.superseded_by === undefined ? {} : { supersededBy: String(options.superseded_by) }),
        note: requireOption(options, "note"),
      }),
    );
    return;
  }
  throw new TypeError(
    `Unknown assets subcommand: ${subcommand ?? "(none)"}; use add, list, check, or retire`,
  );
}

async function openchatcutCommand(subcommand, options) {
  const workspace =
    options.workspace_root === undefined ? {} : { workspaceRoot: resolve(String(options.workspace_root)) };
  if (subcommand === "status") {
    output(await checkOpenChatCut(workspace));
    return;
  }
  if (subcommand === "install") {
    output(await installOpenChatCut(workspace));
    return;
  }
  if (subcommand === "start") {
    const code = await startOpenChatCut({
      ...workspace,
      desktop: booleanFlag(options, "desktop"),
      onStart: (info) => output({ starting: info }),
    });
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (subcommand === "connect") {
    output(await connectClaudeCode(workspace));
    return;
  }
  if (subcommand === "up") {
    const projectId = options.project_id === undefined ? null : requireOption(options, "project_id");
    output(
      await upOpenChatCut({
        ...workspace,
        desktop: booleanFlag(options, "desktop"),
        projectId,
        open: booleanFlag(options, "open") || Boolean(projectId),
        waitBinding: Boolean(projectId) && !booleanFlag(options, "no_wait"),
        ...(options.timeout_seconds === undefined ? {} : { timeoutSeconds: Number(requireOption(options, "timeout_seconds")) }),
      }),
    );
    return;
  }
  if (subcommand === "stop") {
    output(await stopOpenChatCut(workspace));
    return;
  }
  if (subcommand === "open") {
    output(
      await openOpenChatCut({
        ...(options.project_id === undefined ? {} : { projectId: requireOption(options, "project_id") }),
      }),
    );
    return;
  }
  if (subcommand === "import") {
    output(
      await importIntoOpenChatCut({
        ...workspace,
        projectId: requireOption(options, "project_id"),
        files: requireOption(options, "files").split(",").map((value) => value.trim()).filter(Boolean),
      }),
    );
    return;
  }
  if (subcommand === "render") {
    output(
      await renderInOpenChatCut({
        ...workspace,
        projectId: requireOption(options, "project_id"),
        ...(options.name === undefined ? {} : { name: requireOption(options, "name") }),
        ...(options.codec === undefined ? {} : { codec: requireOption(options, "codec") }),
        ...(options.resolution === undefined ? {} : { resolution: requireOption(options, "resolution") }),
        ...(options.fps === undefined ? {} : { fps: Number(requireOption(options, "fps")) }),
        ...(options.timeout_seconds === undefined ? {} : { timeoutSeconds: Number(requireOption(options, "timeout_seconds")) }),
        ...(options.timeline_out === undefined ? {} : { timelineOutPath: requireOption(options, "timeline_out") }),
        saveToMediaPool: booleanFlag(options, "save_to_media_pool"),
      }),
    );
    return;
  }
  throw new TypeError(
    `Unknown openchatcut subcommand: ${subcommand ?? "(none)"}; use status, install, up, stop, open, start, connect, import, or render`,
  );
}

async function main() {
  await loadEnvFile(resolve(".env"));
  const { command, subcommand, options } = parseArgs(process.argv.slice(2));

  if (command === "help" || options.help) {
    help();
    return;
  }
  if (command === "models") {
    output({
      provider: "evolink",
      models: listEvolinkModels().map((model) => ({
        ...model,
        is_default: model.key === DEFAULT_VIDEO_MODEL,
      })),
    });
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor({ createEvolinkClient: () => new EvolinkClient() });
    output(report);
    // Only a hard failure (missing ffmpeg, broken auth) is worth a non-zero exit;
    // warnings describe degraded rendering that still produces output.
    if (report.status === "error") process.exitCode = 1;
    return;
  }
  if (command === "script") {
    await scriptCommand(subcommand, options);
    return;
  }

  if (command === "assets") {
    await assetsCommand(subcommand, options);
    return;
  }
  if (command === "browser-import") {
    output(await importBrowserTake({
      projectRoot: requireOption(options, "project"), workspaceRoot: options.workspace_root,
      requestPath: requireOption(options, "request"), receiptPath: requireOption(options, "receipt"),
      filePath: requireOption(options, "file"),
    }));
    return;
  }
  if (command === "budget") {
    const jobsRoot = options.jobs_root
      ? String(options.jobs_root)
      : await jobsRootOfProject(requireOption(options, "project"), options.workspace_root);
    const report = await describeProjectBudget({
      jobsRoot,
      ...(options.model === undefined ? {} : { model: String(options.model) }),
      ...(options.resolution === undefined ? {} : { resolution: String(options.resolution) }),
    });
    output(report);
    return;
  }

  if (command === "plan") {
    if (options.requests !== undefined) {
      const report = await planRequestDirectory(resolve(String(options.requests)), {
        jobsRoot: options.jobs_root ? String(options.jobs_root) : "artifacts/jobs",
      });
      output(report);
      if (report.failed > 0) process.exitCode = 1;
      return;
    }
    const requestPath = resolve(requireOption(options, "request"));
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const result = await planVideoJob(request, {
      requestSource: requestPath,
      jobsRoot: options.jobs_root ? resolve(String(options.jobs_root)) : resolve("artifacts/jobs"),
    });
    output({
      job_directory: result.jobDirectory,
      reused: result.reused,
      state: result.state,
      capability_snapshot: result.capabilitySnapshot,
    });
    return;
  }
  if (command === "submit") {
    const result = await submitVideoJob(resolve(requireOption(options, "job")), {
      execute: booleanFlag(options, "execute"),
    });
    output({ job_directory: result.jobDirectory, reused: result.reused, state: result.state });
    return;
  }
  if (command === "status") {
    const result = await refreshVideoJob(resolve(requireOption(options, "job")));
    output({ job_directory: result.jobDirectory, state: result.state, task: result.task });
    return;
  }
  if (command === "wait") {
    if (booleanFlag(options, "all")) {
      const report = await waitForJobsRoot(requireOption(options, "jobs_root"), {
        ...(options.timeout_seconds === undefined
          ? {}
          : { timeoutMs: Number(options.timeout_seconds) * 1_000 }),
        download: !booleanFlag(options, "no_download"),
      });
      output(report);
      if (report.failed > 0) process.exitCode = 1;
      return;
    }
    const timeoutSeconds = Number(options.timeout_seconds ?? 900);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      throw new RangeError("--timeout-seconds must be a non-negative number");
    }
    const result = await waitForVideoJob(resolve(requireOption(options, "job")), {
      timeoutMs: timeoutSeconds * 1000,
      download: !booleanFlag(options, "no_download"),
    });
    output({ job_directory: result.jobDirectory, state: result.state, outputs: result.outputs });
    return;
  }
  if (command === "retry") {
    const result = await prepareRetry(resolve(requireOption(options, "job")), {
      change: requireOption(options, "change"),
      ...(options.take_id === undefined ? {} : { takeId: requireOption(options, "take_id") }),
    });
    output(result);
    return;
  }
  if (command === "jobs") {
    const result = await findJobs(resolve(requireOption(options, "jobs_root")), {
      ...(options.shot === undefined ? {} : { shotId: requireOption(options, "shot") }),
      ...(options.phase === undefined ? {} : { phase: requireOption(options, "phase") }),
      latest: booleanFlag(options, "latest"),
    });
    output(result);
    return;
  }
  if (command === "tasks") {
    output(
      await listProviderTasks({
        ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
      }),
    );
    return;
  }

  if (command === "reconcile") {
    const result = await reconcileVideoJob(resolve(requireOption(options, "job")), {
      ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
      ...(options.window_seconds === undefined ? {} : { windowSeconds: Number(options.window_seconds) }),
      ...(options.task_id === undefined ? {} : { taskId: String(options.task_id) }),
      adopt: booleanFlag(options, "adopt"),
      release: booleanFlag(options, "release"),
    });
    output(result);
    if (["ambiguous", "inconclusive_truncated"].includes(result.status)) process.exitCode = 1;
    return;
  }

  if (command === "assemble") {
    const report = await assembleMaster(resolve(requireOption(options, "manifest")), {
      ...(options.workspace_root === undefined
        ? {}
        : { workspaceRoot: resolve(String(options.workspace_root)) }),
      force: booleanFlag(options, "force"),
      requireReview: booleanFlag(options, "require_review"),
    });
    output(report);
    // Assembly is local and free, so a failed check is reported rather than fatal —
    // but it must not read as success.
    if (report.verification.status !== "ok") process.exitCode = 1;
    return;
  }
  if (command === "adopt-master") {
    const report = await adoptExternalMaster({
      ...(options.workspace_root === undefined
        ? {}
        : { workspaceRoot: resolve(String(options.workspace_root)) }),
      projectRoot: requireOption(options, "project"),
      variantId: requireOption(options, "variant"),
      ...(options.file === undefined ? {} : { sourcePath: requireOption(options, "file") }),
      ...(options.url === undefined ? {} : { sourceUrl: requireOption(options, "url") }),
      ...(options.timeline === undefined ? {} : { timelinePath: requireOption(options, "timeline") }),
      ...(options.renderer === undefined ? {} : { renderer: requireOption(options, "renderer") }),
      ...(options.renderer_project === undefined
        ? {}
        : { rendererProjectId: requireOption(options, "renderer_project") }),
      ...(options.render_id === undefined ? {} : { renderId: requireOption(options, "render_id") }),
      ...(options.note === undefined ? {} : { note: requireOption(options, "note") }),
      ...(options.target_lufs === undefined ? {} : { targetLufs: requireOption(options, "target_lufs") }),
    });
    output(report);
    // Adoption is local and free; a failed measurement is reported, never hidden.
    if (report.verification?.status !== "ok") process.exitCode = 1;
    return;
  }
  if (command === "openchatcut") {
    await openchatcutCommand(subcommand, options);
    return;
  }
  if (command === "extract-frames") {
    output(await extractJobFrames(resolve(requireOption(options, "job"))));
    return;
  }

  if (command === "chain") {
    output(
      await prepareChainedRequest({
        fromJobDirectory: requireOption(options, "from_job"),
        requestPath: requireOption(options, "request"),
        ...(options.frame === undefined ? {} : { position: String(options.frame) }),
        reviewPath: requireOption(options, "review"),
      }),
    );
    return;
  }

  if (command === "detect-speech") {
    const report = await detectJobSpeechSignal(resolve(requireOption(options, "job")));
    output(report);
    return;
  }

  if (command === "verify-speech") {
    const report = await verifyJobSpeech(resolve(requireOption(options, "job")));
    output(report);
    return;
  }
  if (command === "tts") {
    const jobDirectory = resolve(requireOption(options, "job"));
    // Prefer a recorded verification over a hand-typed status: the gate exists
    // to stop a second voice being synthesized over usable native speech.
    let nativeAudioStatus = options.native_audio_status
      ? requireOption(options, "native_audio_status")
      : null;
    let statusSource = "flag";
    if (!nativeAudioStatus) {
      const verification = await latestSpeechVerification(jobDirectory);
      if (!verification) {
        throw new TypeError(
          "--native-audio-status is required unless the job has a speech-verification report; run: video verify-speech --job <dir>",
        );
      }
      nativeAudioStatus = verification.native_audio_status;
      statusSource = verification.report_path ?? "speech verification report";
    }
    const execution = await synthesizeJobNarration(jobDirectory, {
      execute: booleanFlag(options, "execute"),
      nativeAudioStatus,
      format: String(options.format ?? "mp3"),
    });
    output({ ...execution.result, native_audio_status: nativeAudioStatus, status_source: statusSource });
    return;
  }
  throw new TypeError(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.name ?? "Error"}: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
