import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * OpenChatCut is the interactive editing route: an agent-native NLE that runs
 * next to this repository and exposes its timeline over a local MCP endpoint.
 *
 * This module owns everything the route needs from our side — where the
 * checkout lives, which Node runs it, where its dev profile keeps the bearer
 * token, and a small MCP client for health checks — so that the CLI, doctor
 * and skills all read the same answers instead of re-deriving them.
 */

export const OPENCHATCUT_REPOSITORY = "https://github.com/0xsline/OpenChatCut.git";
export const OPENCHATCUT_DEFAULT_ENDPOINT = "http://localhost:5199/api/external-mcp/mcp";
export const OPENCHATCUT_MCP_SERVER_NAME = "openchatcut";
export const OPENCHATCUT_NODE_MAJOR = 24;
/** Workspace directories the editor's agent may import from (desktop app). */
export const OPENCHATCUT_IMPORT_ROOT_NAMES = Object.freeze(["artifacts", "projects", "audio-library"]);

/**
 * npm 12 refuses tarball URLs from a registry host other than the configured
 * one and skips dependency install scripts unless they are allowed. OpenChatCut's
 * lockfile pins two packages on registry.npmmirror.com, and its media binaries
 * (ffmpeg, ffprobe, Electron) arrive through install scripts, so a checkout
 * needs both settings before `npm install` produces a working editor.
 */
export const OPENCHATCUT_NPMRC = `# Local install settings for this checkout (untracked). npm 12 blocks tarball
# URLs from a foreign registry host and dependency install scripts by default;
# the lockfile pins two packages on registry.npmmirror.com, and the media
# binaries below are downloaded by their install scripts.
allow-remote=all
allow-scripts=ffmpeg-static,@ffprobe-installer/darwin-arm64,esbuild,sharp,onnxruntime-node,electron,fsevents,protobufjs,koffi,electron-winstaller
`;

const PROFILE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENV_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SKILL_BASELINE_PATTERN = /skill baseline:\s*(\d{4}-\d{2}-\d{2}(?:\.\d+)?)/i;

const defaultFs = { readdir, readFile, stat, unlink, writeFile };

/** Where a detached editor keeps its pid and log, inside the workspace and out of Git. */
export const EDITOR_STATE_DIRECTORY = ".openchatcut-editor";

function majorOf(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? ""));
  return match ? Number(match[1]) : null;
}

async function isDirectory(fs, path) {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isFile(fs, path) {
  try {
    return (await fs.stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTextIfPresent(fs, path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Where the checkout and its companion files live, relative to this workspace. */
export function resolveOpenChatCutPaths({ workspaceRoot = process.cwd(), env = process.env } = {}) {
  const root = resolve(workspaceRoot);
  const configured = env.OPENCHATCUT_DIR?.trim();
  const checkoutDir = configured ? resolve(root, configured) : resolve(root, "..", "OpenChatCut");
  return {
    workspaceRoot: root,
    checkoutDir,
    packageJsonPath: join(checkoutDir, "package.json"),
    viteBinPath: join(checkoutDir, "node_modules", ".bin", "vite"),
    envLocalPath: join(checkoutDir, ".env.local"),
    envExamplePath: join(checkoutDir, ".env.example"),
    npmrcPath: join(checkoutDir, ".npmrc"),
    gitPath: join(checkoutDir, ".git"),
    mcpConfigPath: join(root, ".mcp.json"),
    importRoots: OPENCHATCUT_IMPORT_ROOT_NAMES.map((name) => join(root, name)),
  };
}

export function parseImportRoots(value) {
  return String(value ?? "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unquote(value) {
  const trimmed = value.trim();
  const delimiter = trimmed[0];
  if (trimmed.length >= 2 && ['"', "'", "`"].includes(delimiter) && trimmed.endsWith(delimiter)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Add our workspace roots to AGENT_IMPORT_ROOTS in an OpenChatCut `.env.local`
 * without touching anything else in the file: entries the user configured stay
 * first, ours are appended once, and an unchanged file is reported as such.
 */
export function mergeImportRoots(text, roots) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*(?:export\s+)?AGENT_IMPORT_ROOTS\s*=/.test(line));
  const existing = index === -1 ? [] : parseImportRoots(unquote(lines[index].slice(lines[index].indexOf("=") + 1)));
  const merged = [...new Set([...existing, ...roots])];
  const assignment = `AGENT_IMPORT_ROOTS=${merged.join(",")}`;
  if (index === -1) {
    const separator = source.length && !source.endsWith("\n") ? "\n" : "";
    return {
      text: `${source}${separator}# LidFly workspace roots the OpenChatCut agent may import from (desktop app).\n${assignment}\n`,
      changed: true,
      roots: merged,
    };
  }
  if (merged.length === existing.length) return { text: source, changed: false, roots: merged };
  lines[index] = assignment;
  return { text: lines.join("\n"), changed: true, roots: merged };
}

/**
 * Make sure the checkout has a `.env.local` that lists our workspace roots.
 * A missing file is seeded from `.env.example`, exactly as the upstream README
 * instructs; an existing one is only ever extended.
 */
export async function ensureEnvLocal(paths, { fs = defaultFs } = {}) {
  let text = await readTextIfPresent(fs, paths.envLocalPath);
  const created = text === null;
  if (created) text = (await readTextIfPresent(fs, paths.envExamplePath)) ?? "";
  const merged = mergeImportRoots(text, paths.importRoots);
  if (created || merged.changed) await fs.writeFile(paths.envLocalPath, merged.text, "utf8");
  return {
    path: paths.envLocalPath,
    created,
    updated: !created && merged.changed,
    import_roots: merged.roots,
  };
}

async function resolveGitDirectory(fs, gitPath) {
  let info;
  try {
    info = await fs.stat(gitPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isDirectory()) return gitPath;
  // A worktree checkout keeps a ".git" file pointing at the real directory.
  const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(gitPath, "utf8"));
  if (!match) return null;
  const target = match[1].trim();
  return isAbsolute(target) ? target : resolve(dirname(gitPath), target);
}

/**
 * The isolated development profile `npm run dev` creates for this checkout.
 *
 * OpenChatCut keeps projects, media and the MCP bearer token per checkout under
 * ~/.openchatcut/dev-profiles/<id>/, and records the id inside the checkout's
 * .git directory. Reading it here is what lets `connect` and `status` find the
 * token without anyone pasting it around.
 */
export async function readDevProfile(paths, { homeDir = homedir(), fs = defaultFs } = {}) {
  const gitDirectory = await resolveGitDirectory(fs, paths.gitPath);
  if (!gitDirectory) return null;
  const metadataPath = join(gitDirectory, "openchatcut-dev-profile.json");
  const text = await readTextIfPresent(fs, metadataPath);
  if (text === null) return null;
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch (error) {
    throw new Error(`OpenChatCut dev profile metadata is not valid JSON: ${metadataPath} (${error.message})`);
  }
  const id = metadata?.profileId;
  if (typeof id !== "string" || !PROFILE_ID_PATTERN.test(id)) {
    throw new Error(`OpenChatCut dev profile metadata has an unexpected profileId: ${metadataPath}`);
  }
  const rootDir = join(homeDir, ".openchatcut", "dev-profiles", id);
  return {
    id,
    metadata_path: metadataPath,
    root_dir: rootDir,
    token_path: join(rootDir, "mcp-token"),
    media_uploads_dir: join(rootDir, "media", "uploads"),
  };
}

/**
 * The bearer token the MCP endpoint expects. An explicit OPENCHATCUT_MCP_TOKEN
 * wins (the server honours the same override); otherwise the token the server
 * minted into its dev profile is used. The value is returned for use, never
 * for printing.
 */
export async function resolveMcpToken({ env = process.env, profile = null, fs = defaultFs } = {}) {
  const fromEnv = env.OPENCHATCUT_MCP_TOKEN?.trim();
  if (fromEnv) {
    if (!ENV_TOKEN_PATTERN.test(fromEnv)) {
      throw new Error("OPENCHATCUT_MCP_TOKEN must be 8-256 URL-safe characters (letters, digits, '-' or '_')");
    }
    return { source: "env", token: fromEnv, path: null };
  }
  if (profile) {
    const raw = await readTextIfPresent(fs, profile.token_path);
    if (raw !== null && PROFILE_TOKEN_PATTERN.test(raw.trim())) {
      return { source: "profile", token: raw.trim(), path: profile.token_path };
    }
  }
  return { source: null, token: null, path: profile?.token_path ?? null };
}

function compareVersionsDescending(left, right) {
  const parse = (name) => name.slice(1).split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

/**
 * OpenChatCut enforces Node 24.x through its package.json engines field.
 * This repository runs on Node 20+, so the editor may need a different binary:
 * an explicit OPENCHATCUT_NODE, the current process when it already is 24, or
 * the newest 24.x that nvm has installed.
 */
export async function findNodeBinary({
  env = process.env,
  homeDir = homedir(),
  currentVersion = process.versions.node,
  currentExecPath = process.execPath,
  fs = defaultFs,
} = {}) {
  const configured = env.OPENCHATCUT_NODE?.trim();
  if (configured) return { path: configured, version: null, source: "env" };
  if (majorOf(currentVersion) === OPENCHATCUT_NODE_MAJOR) {
    return { path: currentExecPath, version: currentVersion, source: "current" };
  }
  const versionsDir = join(homeDir, ".nvm", "versions", "node");
  let names = [];
  try {
    names = await fs.readdir(versionsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const pattern = new RegExp(`^v${OPENCHATCUT_NODE_MAJOR}\\.\\d+\\.\\d+$`);
  const candidates = names.filter((name) => pattern.test(name)).sort(compareVersionsDescending);
  if (candidates.length) {
    return { path: join(versionsDir, candidates[0], "bin", "node"), version: candidates[0].slice(1), source: "nvm" };
  }
  return { path: null, version: null, source: null };
}

/**
 * Run npm with the chosen Node rather than whatever `npm` on PATH resolves to:
 * nvm's npm shim is `#!/usr/bin/env node`, which would silently pick the
 * workspace's Node 22 again.
 */
export async function resolveNpmCommand(node, { fs = defaultFs, env = process.env } = {}) {
  const binDir = dirname(node.path);
  const childEnv = { ...env, PATH: `${binDir}:${env.PATH ?? ""}` };
  const npmCli = resolve(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (await isFile(fs, npmCli)) return { command: node.path, args: [npmCli], env: childEnv };
  return { command: "npm", args: [], env: childEnv };
}

/** Facts about the checkout that do not need the server to be running. */
export async function readCheckoutState(paths, { fs = defaultFs } = {}) {
  const present = await isDirectory(fs, paths.checkoutDir);
  let version = null;
  if (present) {
    const packageJson = await readTextIfPresent(fs, paths.packageJsonPath);
    if (packageJson !== null) version = JSON.parse(packageJson).version ?? null;
  }
  const envLocal = present ? await readTextIfPresent(fs, paths.envLocalPath) : null;
  const envLocalRoots = envLocal === null ? [] : mergeImportRoots(envLocal, []).roots;
  return {
    path: paths.checkoutDir,
    present,
    version,
    dependencies_installed: present && (await isFile(fs, paths.viteBinPath)),
    npmrc_present: present && (await isFile(fs, paths.npmrcPath)),
    env_local: {
      path: paths.envLocalPath,
      present: envLocal !== null,
      import_roots: envLocalRoots,
      import_roots_complete: paths.importRoots.every((root) => envLocalRoots.includes(root)),
    },
  };
}

/** Streamable HTTP replies arrive either as JSON or as SSE `data:` lines. */
export function parseMcpBody(text, contentType = "") {
  if (/text\/event-stream/i.test(contentType)) {
    const messages = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) messages.push(JSON.parse(payload));
    }
    return messages;
  }
  if (!String(text).trim()) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isConnectionError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "UND_ERR_SOCKET"].includes(code)) return true;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  return /fetch failed/i.test(String(error?.message ?? ""));
}

/**
 * The smallest MCP client that can hold a Streamable HTTP session: initialize,
 * call a tool, close. Enough for health checks and for reading the editor's
 * state from scripts; interactive editing goes through the agent's own MCP
 * connection.
 */
export class OpenChatCutMcpClient {
  #nextId = 1;

  constructor({
    endpoint = OPENCHATCUT_DEFAULT_ENDPOINT,
    token = null,
    fetchImpl = globalThis.fetch,
    clientName = "lidfly-video",
    timeoutMs = 8_000,
  } = {}) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.clientName = clientName;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.serverInfo = null;
    this.instructions = null;
  }

  #headers(extra = {}) {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-openchatcut-mcp-client": this.clientName,
      "x-openchatcut-mcp-surface": "external",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...extra,
    };
  }

  async #post(body) {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const text = await response.text();
    const messages = response.status === 202 ? [] : parseMcpBody(text, response.headers.get("content-type") ?? "");
    return { status: response.status, messages };
  }

  async initialize() {
    const id = this.#nextId++;
    const { status, messages } = await this.#post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: this.clientName, version: "1" },
      },
    });
    if (status === 401 || status === 403) {
      const error = new Error(`OpenChatCut rejected the MCP bearer token (HTTP ${status})`);
      error.code = "token_rejected";
      error.status = status;
      throw error;
    }
    if (status >= 400) throw new Error(`OpenChatCut MCP initialize failed with HTTP ${status}`);
    const result = messages.find((message) => message?.id === id)?.result ?? messages.find((message) => message?.result)?.result;
    if (!result) throw new Error("OpenChatCut MCP initialize returned no result");
    this.serverInfo = result.serverInfo ?? null;
    this.instructions = result.instructions ?? null;
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  async listTools() {
    const id = this.#nextId++;
    const { status, messages } = await this.#post({ jsonrpc: "2.0", id, method: "tools/list" });
    if (status >= 400) throw new Error(`OpenChatCut tools/list failed with HTTP ${status}`);
    const message = messages.find((entry) => entry?.id === id) ?? messages.at(-1);
    if (message?.error) throw new Error(`tools/list: ${message.error.message}`);
    return message?.result?.tools ?? [];
  }

  async call(name, args = {}) {
    const id = this.#nextId++;
    const { status, messages } = await this.#post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (status >= 400) throw new Error(`OpenChatCut ${name} failed with HTTP ${status}`);
    const message = messages.find((entry) => entry?.id === id) ?? messages.at(-1);
    if (message?.error) throw new Error(`${name}: ${message.error.message}`);
    const result = message?.result;
    if (result?.isError) {
      const text = (result.content ?? []).map((entry) => entry?.text ?? "").join("\n").trim();
      throw new Error(`${name}: ${text || "tool returned an error"}`);
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = (result?.content ?? []).map((entry) => entry?.text ?? "").join("\n").trim();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Closing is a courtesy; the server evicts idle sessions on its own.
    }
    this.sessionId = null;
  }
}

/**
 * Ask the running editor how it is doing. Distinguishes "nothing listens on the
 * port" from "the port answers but our token is wrong": the two need different
 * fixes and used to look identical from a failed tool call.
 */
export async function probeMcp({ endpoint = OPENCHATCUT_DEFAULT_ENDPOINT, token = null, fetchImpl = globalThis.fetch } = {}) {
  const client = new OpenChatCutMcpClient({ endpoint, token, fetchImpl });
  try {
    await client.initialize();
    const status = await client.call("openchatcut_status");
    const projects = await client.call("list_projects");
    const list = Array.isArray(projects) ? projects : projects?.result ?? [];
    return {
      reachable: true,
      authorized: true,
      server_version: client.serverInfo?.version ?? null,
      skill_baseline: SKILL_BASELINE_PATTERN.exec(client.instructions ?? "")?.[1] ?? null,
      connected_project_ids: status?.connectedProjectIds ?? [],
      editors: status?.editors ?? [],
      tool_count: status?.toolCount ?? null,
      projects: list.map((project) => ({
        id: project.id,
        name: project.name ?? null,
        updated_at: project.updatedAt ?? null,
      })),
    };
  } catch (error) {
    if (error?.code === "token_rejected") {
      return {
        reachable: true,
        authorized: false,
        reason: token ? "token_rejected" : "no_token",
        error: error.message,
      };
    }
    if (isConnectionError(error)) {
      return { reachable: false, authorized: false, reason: "not_running", error: error.message };
    }
    throw error;
  } finally {
    await client.close();
  }
}

/**
 * Read-only readiness report for the OpenChatCut route: checkout, Node,
 * dependencies, `.env.local` roots, token source, endpoint health and whether
 * an editor tab is connected. Never starts anything and never prints the token.
 */
export async function checkOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  fetchImpl = globalThis.fetch,
  fs = defaultFs,
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const checkout = await readCheckoutState(paths, { fs });
  const node = await findNodeBinary({ env, homeDir, fs });
  const profile = checkout.present ? await readDevProfile(paths, { homeDir, fs }) : null;
  const token = await resolveMcpToken({ env, profile, fs });
  const endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT;
  const mcp = await probeMcp({ endpoint, token: token.token, fetchImpl });
  const projectConfigPresent = await isFile(fs, paths.mcpConfigPath);

  const notes = [];
  let severity = "ok";
  const warn = (note) => {
    severity = "warning";
    notes.push(note);
  };

  if (!checkout.present) {
    warn(`OpenChatCut checkout not found at ${paths.checkoutDir}; run: node src/cli.mjs openchatcut install`);
  } else {
    if (!checkout.dependencies_installed) {
      warn("OpenChatCut dependencies are not installed; run: node src/cli.mjs openchatcut install");
    }
    if (!checkout.env_local.present) {
      warn("OpenChatCut .env.local is missing; `openchatcut start` seeds it from .env.example");
    } else if (!checkout.env_local.import_roots_complete) {
      warn("OpenChatCut .env.local does not list every workspace import root; `openchatcut start` adds them");
    }
  }
  if (!node.path) {
    warn(`Node ${OPENCHATCUT_NODE_MAJOR}.x not found: install it with nvm or set OPENCHATCUT_NODE`);
  }
  if (!mcp.reachable) {
    notes.push(`OpenChatCut is not running at ${endpoint}; start it with: node src/cli.mjs openchatcut up`);
  } else if (!mcp.authorized) {
    warn(
      token.source
        ? "OpenChatCut rejected our MCP token: the server was started with a different OPENCHATCUT_MCP_TOKEN, or the dev profile was recreated"
        : "No MCP token found: start OpenChatCut once so it mints one into its dev profile, or set OPENCHATCUT_MCP_TOKEN",
    );
  } else if (!mcp.connected_project_ids.length) {
    notes.push("No editor tab is connected: open a project through its editorUrl before timeline, upload, render or export tools");
  }
  if (!projectConfigPresent) {
    warn(`Claude Code project MCP config is missing: ${paths.mcpConfigPath}`);
  }

  return {
    checkout,
    node: { required_major: OPENCHATCUT_NODE_MAJOR, ...node },
    dev_profile: profile ? { id: profile.id, root_dir: profile.root_dir, media_uploads_dir: profile.media_uploads_dir } : null,
    mcp: { endpoint, token_source: token.source, token_path: token.path, ...mcp },
    claude_code: {
      project_mcp_config: projectConfigPresent ? paths.mcpConfigPath : null,
      connect_command: "node src/cli.mjs openchatcut connect",
    },
    status: severity,
    notes,
  };
}

function runChild(spawnImpl, command, args, { cwd, env, capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
  });
}

async function requireInstalledCheckout(paths, { fs }) {
  const checkout = await readCheckoutState(paths, { fs });
  if (!checkout.present) {
    throw new Error(`OpenChatCut checkout not found at ${paths.checkoutDir}; run: node src/cli.mjs openchatcut install`);
  }
  if (!checkout.dependencies_installed) {
    throw new Error("OpenChatCut dependencies are not installed; run: node src/cli.mjs openchatcut install");
  }
  return checkout;
}

async function requireNode(options) {
  const node = await findNodeBinary(options);
  if (!node.path) {
    throw new Error(`OpenChatCut needs Node ${OPENCHATCUT_NODE_MAJOR}.x: install it with nvm or point OPENCHATCUT_NODE at a binary`);
  }
  return node;
}

/**
 * Clone (when absent) and install the editor next to this repository.
 * Writes the local `.npmrc` first so the install can fetch the pinned tarballs
 * and run the media-binary install scripts; leaves an existing `.npmrc` alone.
 */
export async function installOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  spawnImpl = spawn,
  fs = defaultFs,
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const cloned = !(await isDirectory(fs, paths.checkoutDir));
  if (cloned) {
    const clone = await runChild(spawnImpl, "git", ["clone", "--depth", "1", OPENCHATCUT_REPOSITORY, paths.checkoutDir], {
      cwd: paths.workspaceRoot,
      env,
    });
    if (clone.code !== 0) throw new Error(`git clone exited with code ${clone.code}`);
  }
  const npmrcWritten = !(await isFile(fs, paths.npmrcPath));
  if (npmrcWritten) await fs.writeFile(paths.npmrcPath, OPENCHATCUT_NPMRC, "utf8");
  const node = await requireNode({ env, homeDir, fs });
  const npm = await resolveNpmCommand(node, { fs, env });
  const install = await runChild(spawnImpl, npm.command, [...npm.args, "install", "--no-audit", "--no-fund"], {
    cwd: paths.checkoutDir,
    env: npm.env,
  });
  if (install.code !== 0) throw new Error(`npm install exited with code ${install.code}`);
  const envLocal = await ensureEnvLocal(paths, { fs });
  return {
    checkout: paths.checkoutDir,
    cloned,
    npmrc: { path: paths.npmrcPath, written: npmrcWritten },
    node: { path: node.path, version: node.version, source: node.source },
    env_local: envLocal,
  };
}

/**
 * Start the editor (web dev server by default, Electron with `desktop: true`)
 * under Node 24 with our import roots in place. Blocks until the server exits,
 * exactly like running `npm run dev` inside the checkout would.
 */
export async function startOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  desktop = false,
  spawnImpl = spawn,
  fs = defaultFs,
  onStart = () => {},
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  await requireInstalledCheckout(paths, { fs });
  const node = await requireNode({ env, homeDir, fs });
  const envLocal = await ensureEnvLocal(paths, { fs });
  const npm = await resolveNpmCommand(node, { fs, env });
  const script = desktop ? "desktop:dev" : "dev";
  onStart({
    script,
    checkout: paths.checkoutDir,
    node: { path: node.path, version: node.version, source: node.source },
    env_local: envLocal,
    endpoint: env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT,
    token_source: env.OPENCHATCUT_MCP_TOKEN?.trim() ? "env" : "profile",
  });
  const result = await runChild(spawnImpl, npm.command, [...npm.args, "run", script], {
    cwd: paths.checkoutDir,
    env: npm.env,
  });
  return result.code;
}

function redactToken(text, token) {
  return token ? String(text).split(token).join("[redacted]") : String(text);
}

// ---------------------------------------------------------------------------
// Detached lifecycle: up / stop / open, so an agent can bring the editor up
// itself without tying the server to its own shell session.

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function editorStatePaths(paths) {
  const directory = join(paths.workspaceRoot, EDITOR_STATE_DIRECTORY);
  return { directory, pidPath: join(directory, "editor.pid"), logPath: join(directory, "editor.log") };
}

/** Open (append) the editor log for a detached child; returns a file descriptor. */
function defaultOpenLog(state) {
  mkdirSync(state.directory, { recursive: true });
  return openSync(state.logPath, "a");
}

function editorUrlFor(endpoint, projectId) {
  const base = new URL(endpoint);
  return `${base.origin}/#/editor/${encodeURIComponent(projectId)}`;
}

/** Hand a URL to the desktop's default browser and return without waiting. */
async function defaultOpener(url, spawnImpl = spawn) {
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [command, args] = commands[platform()] ?? ["xdg-open", [url]];
  await new Promise((resolveOpen, rejectOpen) => {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.once("error", rejectOpen);
    child.once("spawn", () => {
      child.unref?.();
      resolveOpen();
    });
  });
}

async function readPid(fs, pidPath) {
  const text = await readTextIfPresent(fs, pidPath);
  const pid = Number.parseInt(String(text ?? "").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Poll the endpoint until it answers with our token. The token is re-read on
 * every attempt because a first launch mints it only when the first request
 * arrives, which is this very probe.
 */
export async function waitForEditor({
  endpoint = OPENCHATCUT_DEFAULT_ENDPOINT,
  resolveToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  intervalMs = 2_000,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (true) {
    const token = await resolveToken();
    last = await probeMcp({ endpoint, token, fetchImpl });
    if (last.reachable && last.authorized) return last;
    if (now() >= deadline) {
      const detail = `${last.reason ?? "unknown"}${last.error ? `: ${last.error}` : ""}`;
      throw new Error(`OpenChatCut did not become ready within ${Math.round(timeoutMs / 1000)}s (last: ${detail}); read the editor log`);
    }
    await sleep(intervalMs);
  }
}

/** Poll until an editor tab has the project open, i.e. its tools are registered. */
export async function waitForBinding({
  endpoint = OPENCHATCUT_DEFAULT_ENDPOINT,
  token,
  projectId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  intervalMs = 2_000,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const status = await probeMcp({ endpoint, token, fetchImpl });
    if (!status.reachable || !status.authorized) throw new Error(`OpenChatCut stopped answering while waiting for project ${projectId}: ${status.error ?? status.reason}`);
    if ((status.connected_project_ids ?? []).includes(projectId)) return status;
    if (now() >= deadline) {
      throw new Error(`No editor tab opened project ${projectId} within ${Math.round(timeoutMs / 1000)}s; open ${editorUrlFor(endpoint, projectId)} and retry`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Bring the editor up for an agent task: start it detached when nothing
 * answers, wait until the endpoint accepts our token, then optionally open the
 * project's tab and wait for the editor to register its tools. Idempotent: a
 * running, authorized editor is reported, never duplicated.
 */
export async function upOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  desktop = false,
  projectId = null,
  open = Boolean(projectId),
  waitBinding = Boolean(projectId),
  timeoutSeconds = 180,
  bindingTimeoutSeconds = 120,
  spawnImpl = spawn,
  fs = defaultFs,
  fetchImpl = globalThis.fetch,
  openLog = defaultOpenLog,
  opener = (url) => defaultOpener(url, spawnImpl),
  killImpl = process.kill,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const state = editorStatePaths(paths);
  const endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT;
  const resolveToken = async () => {
    const profile = (await isDirectory(fs, paths.checkoutDir)) ? await readDevProfile(paths, { homeDir, fs }) : null;
    return (await resolveMcpToken({ env, profile, fs })).token;
  };

  const initial = await probeMcp({ endpoint, token: await resolveToken(), fetchImpl });
  let started = false;
  let pid = await readPid(fs, state.pidPath);
  let ready = initial;
  if (initial.reachable && !initial.authorized) {
    throw new Error(
      `OpenChatCut is already running at ${endpoint} but rejects our token (${initial.reason}); it was started with another OPENCHATCUT_MCP_TOKEN or from another checkout. Stop it or align the token before starting again.`,
    );
  }
  if (!initial.reachable) {
    if (pid && !processAlive(pid, killImpl)) {
      await fs.unlink(state.pidPath).catch(() => undefined);
      pid = null;
    }
    await requireInstalledCheckout(paths, { fs });
    const node = await requireNode({ env, homeDir, fs });
    await ensureEnvLocal(paths, { fs });
    const npm = await resolveNpmCommand(node, { fs, env });
    const logFd = openLog(state);
    const child = spawnImpl(npm.command, [...npm.args, "run", desktop ? "desktop:dev" : "dev"], {
      cwd: paths.checkoutDir,
      // The dashboard tab is not needed; the project tab is opened below on request.
      env: { ...npm.env, BROWSER: "none" },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref?.();
    pid = child.pid ?? null;
    started = true;
    await fs.writeFile(state.pidPath, `${pid}\n`, "utf8");
    ready = await waitForEditor({ endpoint, resolveToken, fetchImpl, timeoutMs: timeoutSeconds * 1000, sleep, now });
  }

  let editorUrl = null;
  let bound = null;
  if (projectId) {
    editorUrl = editorUrlFor(endpoint, projectId);
    const alreadyBound = (ready.connected_project_ids ?? []).includes(projectId);
    if (open && !alreadyBound) await opener(editorUrl);
    if (waitBinding && !alreadyBound) {
      bound = await waitForBinding({
        endpoint,
        token: await resolveToken(),
        projectId,
        fetchImpl,
        timeoutMs: bindingTimeoutSeconds * 1000,
        sleep,
        now,
      });
    }
  } else if (open) {
    editorUrl = new URL(endpoint).origin;
    await opener(editorUrl);
  }
  const final = bound ?? ready;
  return {
    started,
    already_running: !started,
    pid,
    managed: pid !== null,
    log_path: state.logPath,
    endpoint,
    server_version: final.server_version ?? null,
    connected_project_ids: final.connected_project_ids ?? [],
    editor_url: editorUrl,
    project_bound: projectId ? (final.connected_project_ids ?? []).includes(projectId) : null,
  };
}

/**
 * Stop an editor that `up` started. An editor started elsewhere is left alone
 * and reported, because killing a process by port would also take out whatever
 * the user had open in it.
 */
export async function stopOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  fs = defaultFs,
  fetchImpl = globalThis.fetch,
  killImpl = process.kill,
  sleep = defaultSleep,
  now = Date.now,
  timeoutMs = 15_000,
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const state = editorStatePaths(paths);
  const endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT;
  const pid = await readPid(fs, state.pidPath);
  if (!pid || !processAlive(pid, killImpl)) {
    if (pid) await fs.unlink(state.pidPath).catch(() => undefined);
    const probe = await probeMcp({ endpoint, token: null, fetchImpl });
    return probe.reachable
      ? { stopped: false, reason: "not_managed", note: `An editor answers at ${endpoint} but was not started by openchatcut up; stop it where it was started` }
      : { stopped: false, reason: "not_running" };
  }
  const signal = (name) => {
    try {
      killImpl(-pid, name); // the detached child leads its own process group: npm and vite together
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      killImpl(pid, name);
    }
  };
  signal("SIGTERM");
  const deadline = now() + timeoutMs;
  let forced = false;
  while (processAlive(pid, killImpl)) {
    if (now() >= deadline) {
      signal("SIGKILL");
      forced = true;
      break;
    }
    await sleep(500);
  }
  await fs.unlink(state.pidPath).catch(() => undefined);
  return { stopped: true, pid, forced };
}

/** Open a project's editor tab (or the dashboard) in the default browser. */
export async function openOpenChatCut({
  env = process.env,
  projectId = null,
  opener = (url) => defaultOpener(url),
} = {}) {
  const endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT;
  const url = projectId ? editorUrlFor(endpoint, projectId) : new URL(endpoint).origin;
  await opener(url);
  return { opened: url };
}

const MEDIA_TYPES = Object.freeze({
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  mov: ["video", "video/quicktime"],
  webm: ["video", "video/webm"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  m4a: ["audio", "audio/mp4"],
  aac: ["audio", "audio/aac"],
  ogg: ["audio", "audio/ogg"],
  flac: ["audio", "audio/flac"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  webp: ["image", "image/webp"],
  gif: ["gif", "image/gif"],
  svg: ["svg", "image/svg+xml"],
});

/** What the editor's upload slot must be told about a file, from its extension. */
export function mediaTypeForFile(path) {
  const extension = String(path).split(".").pop()?.toLowerCase() ?? "";
  const entry = MEDIA_TYPES[extension];
  if (!entry) throw new TypeError(`Unsupported media file for OpenChatCut import: ${path}`);
  return { asset_type: entry[0], content_type: entry[1] };
}

const TERMINAL_SESSION_STATUSES = new Set(["applied", "rejected", "discarded", "stale", "cancelled", "failed"]);
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed", "cancelled", "error"]);

function unwrapList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.sessions)) return value.sessions;
  return [];
}

async function beginEditSession(client, { clientName, approvalMode }) {
  try {
    return await client.call("begin_edit_session", { clientName, approvalMode });
  } catch (error) {
    if (!/already active/i.test(String(error?.message))) throw error;
    // A client that crashed mid-session leaves its draft behind; once its
    // transport is gone the editor marks it orphaned and lets us discard it.
    const orphaned = unwrapList(await client.call("list_edit_sessions", {})).filter(
      (entry) => entry?.orphaned && !TERMINAL_SESSION_STATUSES.has(entry.status) && (entry.recoveryActions ?? []).includes("discard"),
    );
    if (!orphaned.length) {
      throw new Error(`${error.message} The active session belongs to a live client; finish or discard it there first.`);
    }
    for (const entry of orphaned) {
      await client.call("recover_edit_session", { editSessionId: entry.editSessionId, action: "discard" });
    }
    return client.call("begin_edit_session", { clientName, approvalMode });
  }
}

/**
 * Run `work` inside a fresh MCP transport bound to a browser-open project with
 * its own edit session, then discard the session and close the transport.
 *
 * Fresh per call on purpose: the editor invalidates a transport's binding as
 * soon as the live project revision moves (an import finalizes, a draft is
 * applied), so every unit of real-project work gets a binding of its own
 * instead of inheriting one that is already stale.
 */
export async function withEditSession(
  { endpoint = OPENCHATCUT_DEFAULT_ENDPOINT, token, fetchImpl = globalThis.fetch, projectId, clientName = "lidfly-video", approvalMode = "auto", timeoutMs = 120_000 },
  work,
) {
  if (!token) throw new Error("No OpenChatCut MCP token available; run: node src/cli.mjs openchatcut status");
  const client = new OpenChatCutMcpClient({ endpoint, token, fetchImpl, clientName, timeoutMs });
  await client.initialize();
  try {
    const target = await client.call("target_project", { projectId });
    if (target?.bindingMode !== "browser") {
      throw new Error(
        `Project ${projectId} is not open in a connected editor tab (binding mode: ${target?.bindingMode ?? "none"}); open ${target?.editorUrl ?? "its editorUrl"} first`,
      );
    }
    const session = await beginEditSession(client, { clientName, approvalMode });
    const editSessionId = session.editSessionId;
    try {
      return await work({ client, editSessionId, session, target });
    } finally {
      // The draft carried no operations of ours; a stale or already-closed
      // session makes this a no-op, which is fine.
      await client.call("discard_edit_session", { editSessionId }).catch(() => undefined);
    }
  } finally {
    await client.close();
  }
}

async function resolveEditorAccess({ workspaceRoot, env, homeDir, fs }) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const profile = (await isDirectory(fs, paths.checkoutDir)) ? await readDevProfile(paths, { homeDir, fs }) : null;
  const token = await resolveMcpToken({ env, profile, fs });
  const endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT;
  return { paths, profile, token: token.token, endpoint };
}

/**
 * Import local files into an open editor project through the external upload
 * handoff: one slot, one upload, one finalize per file, each in its own
 * transport because finalize moves the project revision. The files are read,
 * never moved; the editor's content hash is compared with ours so the pool
 * asset is provably the reviewed take.
 */
export async function importIntoOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  fetchImpl = globalThis.fetch,
  fs = defaultFs,
  projectId,
  files,
  probe,
  hashFile: hashFileImpl,
  clientName = "lidfly-video",
} = {}) {
  if (!projectId) throw new TypeError("projectId is required");
  if (!Array.isArray(files) || !files.length) throw new TypeError("at least one file is required");
  const probeImpl = probe ?? (await import("../media/ffmpeg.mjs")).probeMedia;
  const hashImpl = hashFileImpl ?? (await import("../core/hashing.mjs")).hashFile;
  const access = await resolveEditorAccess({ workspaceRoot, env, homeDir, fs });
  const imported = [];
  for (const file of files) {
    const absolute = resolve(access.paths.workspaceRoot, file);
    const media = mediaTypeForFile(absolute);
    const bytes = await fs.readFile(absolute);
    const sha256 = await hashImpl(absolute);
    const facts = await probeImpl(absolute);
    const filename = absolute.split("/").pop();
    const result = await withEditSession(
      { endpoint: access.endpoint, token: access.token, fetchImpl, projectId, clientName },
      async ({ client, editSessionId }) => {
        const opened = await client.call("import_media", {
          editSessionId,
          action: "create_session",
          assetType: media.asset_type,
          filename,
          contentType: media.content_type,
          size: bytes.length,
        });
        const slot = opened?.slots?.[0];
        if (!slot?.uploadUrl) throw new Error(`import_media returned no upload slot for ${filename}`);
        const uploadUrl = /^https?:/.test(slot.uploadUrl) ? slot.uploadUrl : new URL(slot.uploadUrl, access.endpoint).toString();
        const upload = await fetchImpl(uploadUrl, {
          method: "POST",
          headers: { "content-type": media.content_type, "content-length": String(bytes.length) },
          body: bytes,
        });
        if (!upload.ok) throw new Error(`upload of ${filename} failed with HTTP ${upload.status}`);
        const receipt = (await upload.json())?.receipt;
        if (!receipt) throw new Error(`upload of ${filename} returned no receipt`);
        const needsDuration = ["video", "audio", "gif"].includes(media.asset_type);
        const finalized = await client.call("finalize_uploaded_asset", {
          editSessionId,
          receipt,
          assetType: media.asset_type,
          ...(needsDuration ? { durationInSeconds: facts.duration_seconds } : {}),
          ...(facts.video ? { width: facts.video.width, height: facts.video.height, fps: facts.video.frame_rate } : {}),
          hasAudioTrack: Boolean(facts.audio),
        });
        return { slot, finalized };
      },
    );
    const { finalized } = result;
    imported.push({
      path: absolute,
      sha256,
      asset_id: finalized.assetId ?? null,
      name: finalized.name ?? filename,
      src: finalized.src ?? null,
      content_hash: finalized.contentHash ?? null,
      content_hash_matches: finalized.contentHash ? finalized.contentHash === sha256 : null,
      duration_in_frames: finalized.durationInFrames ?? null,
      width: finalized.width ?? facts.video?.width ?? null,
      height: finalized.height ?? facts.video?.height ?? null,
    });
  }
  return { project_id: projectId, endpoint: access.endpoint, imported };
}

/**
 * Render the open project's active timeline and wait for the file. The
 * timeline snapshot is read first so the adopted master can be checked
 * against exactly what was rendered.
 */
export async function renderInOpenChatCut({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  fetchImpl = globalThis.fetch,
  fs = defaultFs,
  projectId,
  name,
  format = "video",
  codec = "h264",
  resolution,
  fps,
  saveToMediaPool = false,
  timeoutSeconds = 900,
  timelineOutPath,
  clientName = "lidfly-video",
  now = () => Date.now(),
} = {}) {
  if (!projectId) throw new TypeError("projectId is required");
  const access = await resolveEditorAccess({ workspaceRoot, env, homeDir, fs });
  const sessionOptions = { endpoint: access.endpoint, token: access.token, fetchImpl, projectId, clientName };

  const submitted = await withEditSession(sessionOptions, async ({ client, editSessionId }) => {
    const timeline = await client.call("read_timeline", { editSessionId });
    const render = await client.call("submit_render_job", {
      editSessionId,
      format,
      codec,
      ...(resolution ? { resolution } : {}),
      ...(fps ? { fps } : {}),
      ...(name ? { name } : {}),
      saveToMediaPool,
    });
    return { timeline, render };
  });
  const renderId = submitted.render?.renderId ?? submitted.render?.id;
  if (!renderId) throw new Error(`submit_render_job returned no renderId: ${JSON.stringify(submitted.render)}`);
  if (timelineOutPath) {
    await fs.writeFile(resolve(access.paths.workspaceRoot, timelineOutPath), `${JSON.stringify(submitted.timeline, null, 2)}\n`, "utf8");
  }

  // Polling runs in a transport of its own: submitting may already have moved
  // the project revision (export history), which would stale the first one.
  const deadline = now() + timeoutSeconds * 1000;
  let status = null;
  await withEditSession(sessionOptions, async ({ client, editSessionId }) => {
    while (true) {
      const remaining = Math.max(1, Math.min(45, Math.ceil((deadline - now()) / 1000)));
      status = await client.call("track_export", { editSessionId, action: "wait", renderIds: renderId, timeoutSeconds: remaining });
      const state = status?.status ?? status?.jobs?.[0]?.status ?? null;
      if (TERMINAL_RENDER_STATUSES.has(state)) break;
      if (now() >= deadline) throw new Error(`render ${renderId} did not finish within ${timeoutSeconds}s (last status: ${state})`);
    }
  });
  const state = status?.status ?? status?.jobs?.[0]?.status ?? null;
  const downloadUrl = status?.downloadUrl ?? status?.jobs?.[0]?.downloadUrl ?? null;
  if (state !== "completed" || !downloadUrl) {
    throw new Error(`render ${renderId} ended with status ${state}: ${JSON.stringify(status)}`);
  }
  const absoluteUrl = /^https?:/.test(downloadUrl) ? downloadUrl : new URL(downloadUrl, access.endpoint).toString();
  const fileName = downloadUrl.split("/").pop();
  return {
    project_id: projectId,
    render_id: renderId,
    status: state,
    download_url: absoluteUrl,
    media_path: access.profile && downloadUrl.startsWith("/media/uploads/") ? join(access.profile.media_uploads_dir, fileName) : null,
    timeline_path: timelineOutPath ? resolve(access.paths.workspaceRoot, timelineOutPath) : null,
    timeline_items: Array.isArray(submitted.timeline?.items) ? submitted.timeline.items.length : null,
  };
}

/**
 * Register the endpoint in Claude Code's local scope for this workspace, with
 * the bearer token the running editor actually expects. Local scope lives in
 * the user's own Claude config, never in the repository, and wins over the
 * committed `.mcp.json` entry that needs OPENCHATCUT_MCP_TOKEN exported.
 */
export async function connectClaudeCode({
  workspaceRoot = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  endpoint = env.OPENCHATCUT_MCP_URL?.trim() || OPENCHATCUT_DEFAULT_ENDPOINT,
  spawnImpl = spawn,
  fs = defaultFs,
  claudeBin = "claude",
} = {}) {
  const paths = resolveOpenChatCutPaths({ workspaceRoot, env });
  const profile = (await isDirectory(fs, paths.checkoutDir)) ? await readDevProfile(paths, { homeDir, fs }) : null;
  const token = await resolveMcpToken({ env, profile, fs });
  if (!token.token) {
    throw new Error(
      "No OpenChatCut MCP token available: start the editor once so it mints one into its dev profile, or set OPENCHATCUT_MCP_TOKEN in .env",
    );
  }
  const headers = [
    `Authorization: Bearer ${token.token}`,
    "x-openchatcut-mcp-client: claude-code",
    "x-openchatcut-mcp-surface: external",
  ];
  // A stale entry with the same name blocks `add`; removing it is the documented reset.
  await runChild(spawnImpl, claudeBin, ["mcp", "remove", "-s", "local", OPENCHATCUT_MCP_SERVER_NAME], {
    cwd: paths.workspaceRoot,
    env,
    capture: true,
  });
  // `-H` is variadic in the claude CLI, so the positional name and URL must come
  // before the headers or they are swallowed as extra header values.
  const added = await runChild(
    spawnImpl,
    claudeBin,
    ["mcp", "add", "-s", "local", "-t", "http", OPENCHATCUT_MCP_SERVER_NAME, endpoint, ...headers.flatMap((header) => ["-H", header])],
    { cwd: paths.workspaceRoot, env, capture: true },
  );
  const output = redactToken(`${added.stdout}${added.stderr}`.trim(), token.token);
  if (added.code !== 0) throw new Error(`claude mcp add exited with code ${added.code}: ${output}`);
  return {
    ok: true,
    client: "claude-code",
    scope: "local",
    workspace: paths.workspaceRoot,
    server_name: OPENCHATCUT_MCP_SERVER_NAME,
    endpoint,
    token_source: token.source,
    output,
    codex: {
      command: `codex mcp add ${OPENCHATCUT_MCP_SERVER_NAME} --url ${endpoint} --bearer-token-env-var OPENCHATCUT_MCP_TOKEN`,
      note: token.source === "env"
        ? "Export the same OPENCHATCUT_MCP_TOKEN in the shell that runs Codex."
        : `Export OPENCHATCUT_MCP_TOKEN with the contents of ${token.path} in the shell that runs Codex.`,
    },
  };
}
