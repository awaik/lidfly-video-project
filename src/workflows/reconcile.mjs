import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EvolinkClient } from "../providers/evolink/client.mjs";
import { projectPathsFromJobsRoot, jobsRootFromJobDirectory } from "./budget.mjs";
import { loadVideoJob, persistJobState } from "./video-job.mjs";

const AMBIGUOUS_PHASES = new Set(["submission_started", "submission_unknown"]);
const MAX_SCAN_DEPTH = 6;

/**
 * Every remote task id this workspace has already claimed.
 *
 * The EVOLINK key is shared by every project, so a task created by a different
 * shot must never be adopted here. This is the check that makes adoption safe.
 */
async function collectKnownTaskIds(scanRoot) {
  const known = new Map();
  async function walk(directory, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (entry.name !== "job.json") continue;
      try {
        const state = JSON.parse(await readFile(path, "utf8"));
        if (state?.remote_task_id) known.set(String(state.remote_task_id), directory);
      } catch {
        // A job manifest we cannot read tells us nothing about task ownership.
      }
    }
  }
  await walk(scanRoot, 0);
  return known;
}

function scanRootFor(jobDirectory) {
  const jobsRoot = jobsRootFromJobDirectory(jobDirectory);
  const paths = projectPathsFromJobsRoot(jobsRoot);
  // A project-bound job shares the account with every other project, so the
  // whole artifacts tree is scanned, not just this project's jobs.
  return paths ? join(paths.workspaceRoot, "artifacts") : jobsRoot;
}

/**
 * Match a job whose submission outcome is unknown against the provider's task
 * list, and either bind the task it created or record that it created none.
 *
 * Read-only by default: adopting or releasing a job is an explicit decision,
 * because both change what may be paid for next.
 */
export async function reconcileVideoJob(
  jobDirectory,
  {
    client = null,
    limit = 50,
    windowSeconds = 900,
    skewSeconds = 60,
    taskId = null,
    adopt = false,
    release = false,
    now = new Date(),
  } = {},
) {
  if (adopt && release) throw new TypeError("--adopt and --release are mutually exclusive");
  const providerClient = client ?? new EvolinkClient();
  const job = await loadVideoJob(jobDirectory);

  if (job.state.remote_task_id) {
    return {
      status: "already_bound",
      job_directory: job.jobDirectory,
      remote_task_id: job.state.remote_task_id,
      phase: job.state.phase,
    };
  }
  if (!AMBIGUOUS_PHASES.has(job.state.phase)) {
    throw new Error(
      `Job phase is "${job.state.phase}"; reconcile is for a job whose submission outcome is ambiguous (submission_started, submission_unknown)`,
    );
  }
  if (!job.state.submission_started_at) {
    throw new Error("Job never started a submission, so there is nothing to reconcile");
  }

  const startedAt = Date.parse(job.state.submission_started_at);
  const window = { from_ms: startedAt - skewSeconds * 1_000, to_ms: startedAt + windowSeconds * 1_000 };
  const listed = await providerClient.listTasks({ limit });
  const known = await collectKnownTaskIds(scanRootFor(job.jobDirectory));

  let candidates = listed.tasks.filter(
    (task) =>
      task.created_at_ms !== null &&
      task.created_at_ms >= window.from_ms &&
      task.created_at_ms <= window.to_ms &&
      (!job.state.resolved_model_id || task.model === job.state.resolved_model_id) &&
      !known.has(task.id),
  );

  // A second discriminator, still free: the provider records the duration it was
  // asked for, and two shots submitted seconds apart usually differ in it.
  if (candidates.length > 1 && candidates.length <= 10 && typeof providerClient.getTask === "function") {
    const detailed = [];
    for (const candidate of candidates) {
      try {
        const task = await providerClient.getTask(candidate.id);
        const duration = Number(task?.task_info?.video_duration ?? task?.task_info?.duration);
        if (!Number.isFinite(duration) || duration === job.request.duration_seconds) {
          detailed.push(candidate);
        }
      } catch {
        detailed.push(candidate);
      }
    }
    if (detailed.length > 0) candidates = detailed;
  }

  const oldestListed = listed.tasks.reduce(
    (oldest, task) => (task.created_at_ms !== null && task.created_at_ms < oldest ? task.created_at_ms : oldest),
    Number.POSITIVE_INFINITY,
  );
  // If the newest page does not reach back to the start of the window, "no task
  // was created" is not something this listing can prove.
  const truncated = listed.count >= limit && oldestListed > window.from_ms;

  const base = {
    job_directory: job.jobDirectory,
    shot_id: job.request.shot_id,
    take_id: job.request.take_id,
    resolved_model_id: job.state.resolved_model_id,
    window: {
      from: new Date(window.from_ms).toISOString(),
      to: new Date(window.to_ms).toISOString(),
    },
    listed: { count: listed.count, limit: listed.limit },
    candidates,
  };

  if (candidates.length > 1 && !taskId) {
    return {
      ...base,
      status: "ambiguous",
      decision: "Несколько задач попадают в окно; выберите нужную через --task-id после проверки в EVOLINK",
    };
  }

  const chosen = taskId
    ? candidates.find((candidate) => candidate.id === taskId)
    : (candidates[0] ?? null);
  if (taskId && !chosen) {
    throw new Error(`Task ${taskId} is not among the candidates for this job; refusing to bind it`);
  }

  if (!chosen) {
    if (truncated) {
      return {
        ...base,
        status: "inconclusive_truncated",
        decision: `Список задач обрезан лимитом ${limit}: отсутствие задачи недоказуемо. Повторите с большим --limit`,
      };
    }
    if (!release) {
      return {
        ...base,
        status: "no_candidate",
        decision: "Задача не создавалась, оплаты не было. Повторите с --release, чтобы открыть retry",
      };
    }
    const state = await persistJobState(job.jobDirectory, {
      ...job.state,
      phase: "submission_lost",
      reconciled: {
        at: now.toISOString(),
        outcome: "no_task_created",
        listed_count: listed.count,
        window: base.window,
      },
    });
    return {
      ...base,
      status: "released",
      phase: state.phase,
      decision: `Задача не найдена; джоб помечен submission_lost. Заведите следующий take: node src/cli.mjs retry --job ${job.jobDirectory} --change "<что меняете>"`,
    };
  }

  if (!adopt) {
    return {
      ...base,
      status: "candidate_found",
      candidate: chosen,
      decision: "Задача найдена; повторите с --adopt, чтобы привязать её к этому джобу",
    };
  }

  const state = await persistJobState(job.jobDirectory, {
    ...job.state,
    phase: String(chosen.status ?? "pending"),
    remote_task_id: chosen.id,
    reconciled: {
      at: now.toISOString(),
      outcome: "adopted",
      task_created_at: new Date(chosen.created_at_ms).toISOString(),
      listed_count: listed.count,
      window: base.window,
    },
  });
  return {
    ...base,
    status: "adopted",
    candidate: chosen,
    phase: state.phase,
    remote_task_id: chosen.id,
    decision: `Задача привязана; заберите результат: node src/cli.mjs wait --job ${job.jobDirectory}`,
  };
}

/** Recent provider tasks, so "what did I actually create" needs no curl. */
export async function listProviderTasks({ client = null, limit = 20 } = {}) {
  const providerClient = client ?? new EvolinkClient();
  const listed = await providerClient.listTasks({ limit });
  return {
    limit: listed.limit,
    count: listed.count,
    tasks: listed.tasks.map((task) => ({
      ...task,
      created_at: task.created_at_ms === null ? null : new Date(task.created_at_ms).toISOString(),
    })),
  };
}
