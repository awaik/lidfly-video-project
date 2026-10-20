import { createWriteStream } from "node:fs";
import { access, link, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ProviderError, providerErrorFromResponse, redact } from "../../core/errors.mjs";

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "expired"]);
const MIME_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Creation time in milliseconds.
 *
 * The task list reports `created_at` and a single task reports `created`, both
 * in seconds; normalizing here keeps the difference out of every caller.
 */
export function taskCreatedAtMs(task) {
  const raw = task?.created_at ?? task?.created ?? null;
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Anything below this threshold is seconds, not milliseconds.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

async function parseJsonResponse(response, context) {
  if (!response.ok) throw await providerErrorFromResponse(response, context);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError(`${context} returned invalid JSON`, { status: response.status });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderError(`${context} returned an unexpected response`, {
      status: response.status,
    });
  }
  return body;
}

export class EvolinkClient {
  constructor({
    apiKey = process.env.EVOLINK_API_KEY,
    baseUrl = process.env.EVOLINK_API_BASE_URL ?? "https://api.evolink.ai",
    filesBaseUrl = process.env.EVOLINK_FILES_BASE_URL ?? "https://files-api.evolink.ai",
    fetchFn = globalThis.fetch,
  } = {}) {
    if (!apiKey) throw new TypeError("EVOLINK_API_KEY is not configured");
    if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.filesBaseUrl = filesBaseUrl.replace(/\/$/, "");
    this.fetch = fetchFn;
  }

  headers({ json = false } = {}) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async uploadImage(path) {
    const extension = extname(path).toLowerCase();
    const mimeType = MIME_TYPES.get(extension);
    if (!mimeType) throw new TypeError(`Unsupported EVOLINK image format: ${extension || "none"}`);
    const info = await stat(path);
    if (!info.isFile()) throw new TypeError(`Reference image is not a file: ${path}`);
    if (info.size > 30 * 1024 * 1024) throw new RangeError(`Reference image exceeds 30MB: ${path}`);
    const contents = await readFile(path);
    const response = await this.fetch(`${this.filesBaseUrl}/api/v1/files/upload/base64`, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify({
        base64_data: `data:${mimeType};base64,${contents.toString("base64")}`,
        file_name: basename(path),
        upload_path: "lidfly-video-inputs",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await parseJsonResponse(response, "EVOLINK file upload");
    const fileUrl = body.data?.file_url ?? body.data?.download_url;
    if (!body.success || !fileUrl) {
      throw new ProviderError("EVOLINK file upload did not return a file URL", {
        status: response.status,
        details: body,
      });
    }
    return {
      file_url: String(fileUrl),
      file_id: body.data?.file_id ?? null,
      expires_at: body.data?.expires_at ?? null,
      response: redact(body),
    };
  }

  async submitVideo(payload) {
    const response = await this.fetch(`${this.baseUrl}/v1/videos/generations`, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await parseJsonResponse(response, "EVOLINK video submission");
    if (!body.id) {
      throw new ProviderError("EVOLINK video submission did not return a task ID", {
        status: response.status,
        details: body,
      });
    }
    return body;
  }

  async getCredits() {
    const response = await this.fetch(`${this.baseUrl}/v1/credits`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await parseJsonResponse(response, "EVOLINK credits");
    if (!body.success || !body.data?.token || !body.data?.user) {
      throw new ProviderError("EVOLINK credits returned an unexpected response", {
        status: response.status,
        details: body,
      });
    }
    return body;
  }

  async preflightUrl(url, role) {
    const response = await this.fetch(url, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await providerErrorFromResponse(response, `Reference ${role} preflight`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
    const expectedPrefix = role === "reference_audio" ? "audio/" :
      ["reference_video", "source_video"].includes(role) ? "video/" : "image/";
    if (contentType && contentType !== "application/octet-stream" && !contentType.startsWith(expectedPrefix)) {
      await response.body?.cancel();
      throw new TypeError(`Reference ${role} returned incompatible Content-Type: ${contentType}`);
    }
    await response.body?.cancel();
    return { content_type: contentType || null, final_url: response.url || url };
  }

  /**
   * Recent tasks on this API key, newest first.
   *
   * Read-only and unbilled. It exists so a job whose submission was cut off by
   * the network can be matched against what the provider actually created,
   * instead of guessing and paying twice.
   */
  async listTasks({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer from 1 to 100");
    }
    const response = await this.fetch(`${this.baseUrl}/v1/tasks?limit=${limit}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await parseJsonResponse(response, "EVOLINK task list");
    if (!Array.isArray(body.data)) {
      throw new ProviderError("EVOLINK task list returned an unexpected response", {
        status: response.status,
        details: body,
      });
    }
    return {
      limit,
      count: body.data.length,
      tasks: body.data.map((task) => ({
        id: task.id,
        model: task.model ?? null,
        status: task.status ?? null,
        progress: task.progress ?? null,
        type: task.type ?? null,
        created_at_ms: taskCreatedAtMs(task),
      })),
    };
  }

  async getTask(taskId) {
    if (typeof taskId !== "string" || !/^task-[A-Za-z0-9._-]+$/.test(taskId)) {
      throw new TypeError("Invalid EVOLINK task ID");
    }
    const response = await this.fetch(`${this.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    return parseJsonResponse(response, "EVOLINK task status");
  }

  async waitForTask(
    taskId,
    {
      timeoutMs = 900_000,
      initialDelayMs = 3_000,
      maxDelayMs = 20_000,
      onUpdate = async () => {},
    } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let delay = initialDelayMs;
    let lastTask = null;
    while (Date.now() <= deadline) {
      try {
        lastTask = await this.getTask(taskId);
        await onUpdate(lastTask);
        const status = String(lastTask.status ?? "").toLowerCase();
        if (status === "completed") return lastTask;
        if (TERMINAL_FAILURES.has(status)) {
          const detail = lastTask.error?.message ?? lastTask.error?.code ?? "unknown provider error";
          throw new ProviderError(`EVOLINK task ${status}: ${detail}`, {
            code: lastTask.error?.code ?? null,
            details: lastTask,
          });
        }
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable) throw error;
      }
      if (Date.now() + delay > deadline) break;
      await sleep(delay);
      delay = Math.min(Math.ceil(delay * 1.6), maxDelayMs);
    }
    throw new ProviderError(`EVOLINK task ${taskId} did not finish within ${timeoutMs}ms`, {
      code: "poll_timeout",
      details: lastTask,
    });
  }

  async downloadResult(url, outputDirectory, { index = 1 } = {}) {
    await mkdir(outputDirectory, { recursive: true });
    let extension = ".mp4";
    try {
      const candidate = extname(new URL(url).pathname).toLowerCase();
      if ([".mp4", ".mov", ".webm"].includes(candidate)) extension = candidate;
    } catch {
      throw new TypeError("EVOLINK result URL is invalid");
    }

    let sequence = index;
    let finalPath;
    let partialPath;
    while (true) {
      const suffix = String(sequence).padStart(2, "0");
      finalPath = join(outputDirectory, `result-${suffix}${extension}`);
      partialPath = `${finalPath}.partial`;
      try {
        await access(finalPath);
        sequence += 1;
        continue;
      } catch {}
      try {
        await access(partialPath);
        sequence += 1;
        continue;
      } catch {}
      break;
    }

    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw await providerErrorFromResponse(response, "EVOLINK result download");
    if (!response.body) throw new ProviderError("EVOLINK result download returned an empty body");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
    await link(partialPath, finalPath);
    await unlink(partialPath);
    return finalPath;
  }
}
