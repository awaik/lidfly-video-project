import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCHATCUT_DEFAULT_ENDPOINT,
  checkOpenChatCut,
  connectClaudeCode,
  ensureEnvLocal,
  findNodeBinary,
  importIntoOpenChatCut,
  mediaTypeForFile,
  mergeImportRoots,
  parseMcpBody,
  probeMcp,
  readDevProfile,
  openOpenChatCut,
  renderInOpenChatCut,
  resolveMcpToken,
  resolveOpenChatCutPaths,
  startOpenChatCut,
  stopOpenChatCut,
  upOpenChatCut,
  waitForBinding,
  waitForEditor,
  withEditSession,
} from "../src/workflows/openchatcut.mjs";

const WORKSPACE = "/work/lidfly-video-project";
const CHECKOUT = "/work/OpenChatCut";
const HOME = "/home/editor";
const PROFILE_ID = "b363716f-ee78-419b-b9eb-16443d8b841e";
const PROFILE_TOKEN = "A".repeat(43);

/**
 * An in-memory file system with just the calls the workflow makes, so the
 * checks can be exercised against any layout without touching the disk.
 */
function memoryFs({ files = {}, directories = [] } = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set(directories);
  const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return {
    store,
    async readFile(path) {
      if (!store.has(path)) throw enoent(path);
      return store.get(path);
    },
    async writeFile(path, content) {
      store.set(path, content);
    },
    async unlink(path) {
      if (!store.delete(path)) throw enoent(path);
    },
    async stat(path) {
      if (store.has(path)) return { isDirectory: () => false, isFile: () => true };
      if (dirs.has(path)) return { isDirectory: () => true, isFile: () => false };
      throw enoent(path);
    },
    async readdir(path) {
      if (!dirs.has(path)) throw enoent(path);
      const prefix = `${path}/`;
      const names = new Set();
      for (const candidate of [...store.keys(), ...dirs]) {
        if (candidate.startsWith(prefix)) names.add(candidate.slice(prefix.length).split("/")[0]);
      }
      return [...names];
    },
  };
}

function installedCheckout({ envLocal = "AGENT_IMPORT_ROOTS=\n", withProfile = true, token = PROFILE_TOKEN } = {}) {
  const profileRoot = join(HOME, ".openchatcut", "dev-profiles", PROFILE_ID);
  return memoryFs({
    files: {
      [join(CHECKOUT, "package.json")]: JSON.stringify({ version: "0.2.17" }),
      [join(CHECKOUT, "node_modules", ".bin", "vite")]: "#!/bin/sh",
      [join(CHECKOUT, ".npmrc")]: "allow-remote=all\n",
      [join(CHECKOUT, ".env.example")]: "LLM_PROVIDER=anthropic\nAGENT_IMPORT_ROOTS=\n",
      ...(envLocal === null ? {} : { [join(CHECKOUT, ".env.local")]: envLocal }),
      ...(withProfile
        ? {
            [join(CHECKOUT, ".git", "openchatcut-dev-profile.json")]: JSON.stringify({
              version: 1,
              profileId: PROFILE_ID,
              repoRoot: CHECKOUT,
            }),
            ...(token === null ? {} : { [join(profileRoot, "mcp-token")]: `${token}\n` }),
          }
        : {}),
      [join(HOME, ".nvm", "versions", "node", "v24.19.0", "bin", "node")]: "",
      [join(HOME, ".nvm", "versions", "node", "v24.19.0", "lib", "node_modules", "npm", "bin", "npm-cli.js")]: "",
      [join(WORKSPACE, ".mcp.json")]: "{}",
    },
    directories: [
      CHECKOUT,
      join(CHECKOUT, ".git"),
      join(HOME, ".nvm", "versions", "node"),
      join(HOME, ".nvm", "versions", "node", "v24.19.0"),
      join(HOME, ".nvm", "versions", "node", "v22.23.2"),
      join(HOME, ".nvm", "versions", "node", "v24.3.0"),
    ],
  });
}

/** SSE body the way the Streamable HTTP server frames its replies. */
function sse(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function response({ status = 200, body = "", headers = {} } = {}) {
  const map = new Map(Object.entries({ "content-type": "text/event-stream", ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status < 400,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    async text() {
      return body;
    },
  };
}

/** A fake editor endpoint: rejects a bad token, otherwise answers the calls the probe makes. */
function fakeEndpoint({ token = PROFILE_TOKEN, status = {}, projects = [] } = {}) {
  const requests = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, ...init, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === "DELETE") return response({ status: 200, body: "" });
      const authorized = init.headers.authorization === `Bearer ${token}`;
      if (!authorized) return response({ status: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid OpenChatCut MCP token" }) });
      const message = JSON.parse(init.body);
      if (message.method === "initialize") {
        return response({
          headers: { "mcp-session-id": "session-1" },
          body: sse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "openchatcut", version: "1.0.0" },
              instructions: "OpenChatCut external skill baseline: 2026-09-04.1. Update with npx skills update openchatcut when older.",
            },
          }),
        });
      }
      if (message.method === "notifications/initialized") return response({ status: 202, body: "" });
      if (message.method === "tools/call" && message.params.name === "openchatcut_status") {
        return response({
          body: sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "{}" }], structuredContent: { connectedProjectIds: [], editors: [], toolCount: 31, ...status } } }),
        });
      }
      if (message.method === "tools/call" && message.params.name === "list_projects") {
        return response({
          body: sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "{}" }], structuredContent: { result: projects } } }),
        });
      }
      throw new Error(`unexpected request ${message.method}`);
    },
  };
}

function refusingFetch() {
  return async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
}

/** Records spawned commands and finishes each one immediately with the given exit code. */
function fakeSpawn({ exitCode = 0, stdout = "", failFor = () => false } = {}) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        child.emit("exit", failFor({ command, args }) ? 1 : exitCode, null);
      });
      return child;
    },
  };
}

test("checkout defaults to ../OpenChatCut and honours OPENCHATCUT_DIR", () => {
  const defaults = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} });
  assert.equal(defaults.checkoutDir, CHECKOUT);
  assert.deepEqual(defaults.importRoots, [
    join(WORKSPACE, "artifacts"),
    join(WORKSPACE, "projects"),
    join(WORKSPACE, "audio-library"),
  ]);

  const configured = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: { OPENCHATCUT_DIR: "../editors/occ" } });
  assert.equal(configured.checkoutDir, "/work/editors/occ");
});

test("import roots are appended once and existing entries are preserved", () => {
  const appended = mergeImportRoots("LLM_PROVIDER=anthropic\n", ["/a", "/b"]);
  assert.equal(appended.changed, true);
  assert.match(appended.text, /^LLM_PROVIDER=anthropic\n# LidFly workspace roots[^\n]*\nAGENT_IMPORT_ROOTS=\/a,\/b\n$/);

  const extended = mergeImportRoots('AGENT_IMPORT_ROOTS="/user/media,/a"\n', ["/a", "/b"]);
  assert.equal(extended.changed, true);
  assert.equal(extended.text, "AGENT_IMPORT_ROOTS=/user/media,/a,/b\n");
  assert.deepEqual(extended.roots, ["/user/media", "/a", "/b"]);

  const unchanged = mergeImportRoots("AGENT_IMPORT_ROOTS=/a,/b\n# comment\n", ["/a", "/b"]);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.text, "AGENT_IMPORT_ROOTS=/a,/b\n# comment\n");

  // A commented-out template line is not an assignment.
  const commented = mergeImportRoots("# AGENT_IMPORT_ROOTS=/old\n", ["/a"]);
  assert.match(commented.text, /^# AGENT_IMPORT_ROOTS=\/old\n# LidFly[^\n]*\nAGENT_IMPORT_ROOTS=\/a\n$/);
});

test("a missing .env.local is seeded from .env.example with our roots", async () => {
  const fs = installedCheckout({ envLocal: null });
  const paths = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} });
  const result = await ensureEnvLocal(paths, { fs });

  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  const written = fs.store.get(paths.envLocalPath);
  assert.match(written, /^LLM_PROVIDER=anthropic\n/);
  assert.match(written, new RegExp(`^AGENT_IMPORT_ROOTS=${WORKSPACE}/artifacts,${WORKSPACE}/projects,${WORKSPACE}/audio-library$`, "m"));

  const second = await ensureEnvLocal(paths, { fs });
  assert.deepEqual([second.created, second.updated], [false, false]);
});

test("the dev profile is read through a worktree .git file and validated", async () => {
  const worktreeGitDir = "/work/main/.git/worktrees/occ";
  const fs = memoryFs({
    files: {
      [join(CHECKOUT, ".git")]: `gitdir: ${worktreeGitDir}\n`,
      [join(worktreeGitDir, "openchatcut-dev-profile.json")]: JSON.stringify({ version: 1, profileId: PROFILE_ID, repoRoot: CHECKOUT }),
    },
  });
  const paths = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} });
  const profile = await readDevProfile(paths, { homeDir: HOME, fs });
  assert.equal(profile.id, PROFILE_ID);
  assert.equal(profile.token_path, join(HOME, ".openchatcut", "dev-profiles", PROFILE_ID, "mcp-token"));
  assert.equal(profile.media_uploads_dir, join(HOME, ".openchatcut", "dev-profiles", PROFILE_ID, "media", "uploads"));

  fs.store.set(join(worktreeGitDir, "openchatcut-dev-profile.json"), JSON.stringify({ profileId: "../../etc" }));
  await assert.rejects(readDevProfile(paths, { homeDir: HOME, fs }), /unexpected profileId/);

  assert.equal(await readDevProfile(paths, { homeDir: HOME, fs: memoryFs() }), null);
});

test("the token comes from the environment first, then the dev profile, and is validated", async () => {
  const fs = installedCheckout();
  const paths = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} });
  const profile = await readDevProfile(paths, { homeDir: HOME, fs });

  const fromEnv = await resolveMcpToken({ env: { OPENCHATCUT_MCP_TOKEN: " pinned-token-value " }, profile, fs });
  assert.deepEqual(fromEnv, { source: "env", token: "pinned-token-value", path: null });

  const fromProfile = await resolveMcpToken({ env: {}, profile, fs });
  assert.equal(fromProfile.source, "profile");
  assert.equal(fromProfile.token, PROFILE_TOKEN);

  fs.store.set(profile.token_path, "corrupted\n");
  const corrupted = await resolveMcpToken({ env: {}, profile, fs });
  assert.deepEqual([corrupted.source, corrupted.token], [null, null]);

  await assert.rejects(resolveMcpToken({ env: { OPENCHATCUT_MCP_TOKEN: "has spaces in it" }, profile, fs }), /URL-safe/);
});

test("Node 24 is resolved from the override, the current process, or the newest nvm 24.x", async () => {
  const fs = installedCheckout();
  const base = { homeDir: HOME, fs, currentVersion: "22.23.2", currentExecPath: "/usr/local/bin/node" };

  assert.deepEqual(await findNodeBinary({ ...base, env: { OPENCHATCUT_NODE: "/opt/node24/bin/node" } }), {
    path: "/opt/node24/bin/node",
    version: null,
    source: "env",
  });
  assert.deepEqual(await findNodeBinary({ ...base, env: {}, currentVersion: "24.1.0", currentExecPath: "/opt/current/node" }), {
    path: "/opt/current/node",
    version: "24.1.0",
    source: "current",
  });
  const fromNvm = await findNodeBinary({ ...base, env: {} });
  assert.equal(fromNvm.version, "24.19.0");
  assert.equal(fromNvm.path, join(HOME, ".nvm", "versions", "node", "v24.19.0", "bin", "node"));

  const none = await findNodeBinary({ ...base, env: {}, homeDir: "/nowhere" });
  assert.deepEqual(none, { path: null, version: null, source: null });
});

test("MCP replies are parsed from SSE frames and from plain JSON alike", () => {
  const framed = parseMcpBody(`event: message\ndata: {"id":1,"result":{"ok":true}}\n\nevent: message\ndata: {"id":2,"result":{}}\n`, "text/event-stream");
  assert.deepEqual(framed.map((message) => message.id), [1, 2]);
  assert.deepEqual(parseMcpBody('{"id":3,"result":null}', "application/json"), [{ id: 3, result: null }]);
  assert.deepEqual(parseMcpBody("", "application/json"), []);
});

test("the probe tells a stopped editor from a wrong token from a healthy one", async () => {
  const stopped = await probeMcp({ token: PROFILE_TOKEN, fetchImpl: refusingFetch() });
  assert.deepEqual([stopped.reachable, stopped.authorized, stopped.reason], [false, false, "not_running"]);

  const endpoint = fakeEndpoint({ projects: [{ id: "p1", name: "Demo", updatedAt: 5 }], status: { connectedProjectIds: ["p1"] } });
  const rejected = await probeMcp({ token: "B".repeat(43), fetchImpl: endpoint.fetch });
  assert.deepEqual([rejected.reachable, rejected.authorized, rejected.reason], [true, false, "token_rejected"]);

  const missing = await probeMcp({ token: null, fetchImpl: endpoint.fetch });
  assert.equal(missing.reason, "no_token");

  const healthy = await probeMcp({ token: PROFILE_TOKEN, fetchImpl: endpoint.fetch });
  assert.equal(healthy.authorized, true);
  assert.equal(healthy.skill_baseline, "2026-09-04.1");
  assert.equal(healthy.tool_count, 31);
  assert.deepEqual(healthy.connected_project_ids, ["p1"]);
  assert.deepEqual(healthy.projects, [{ id: "p1", name: "Demo", updated_at: 5 }]);
  // The session is closed after the probe, and every call carried our client headers.
  assert.equal(endpoint.requests.at(-1).method, "DELETE");
  assert.ok(endpoint.requests.every((request) => request.headers["x-openchatcut-mcp-surface"] === "external"));
});

test("status reports a missing checkout as a warning with the install command", async () => {
  const report = await checkOpenChatCut({
    workspaceRoot: WORKSPACE,
    env: {},
    homeDir: HOME,
    fs: memoryFs(),
    fetchImpl: refusingFetch(),
  });
  assert.equal(report.status, "warning");
  assert.equal(report.checkout.present, false);
  assert.equal(report.mcp.reachable, false);
  assert.ok(report.notes.some((note) => /openchatcut install/.test(note)));
  assert.ok(report.notes.some((note) => /openchatcut up/.test(note)));
  assert.ok(report.notes.some((note) => /\.mcp\.json/.test(note)));
});

test("status is ok for an installed, running, authorized editor and never carries the token", async () => {
  const roots = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} }).importRoots;
  const fs = installedCheckout({ envLocal: `AGENT_IMPORT_ROOTS=${roots.join(",")}\n` });
  const endpoint = fakeEndpoint({ status: { connectedProjectIds: ["p1"], editors: [{ projectId: "p1" }] } });
  const report = await checkOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, fetchImpl: endpoint.fetch });

  assert.equal(report.status, "ok");
  assert.deepEqual(report.notes, []);
  assert.equal(report.checkout.env_local.import_roots_complete, true);
  assert.equal(report.mcp.token_source, "profile");
  assert.equal(report.mcp.authorized, true);
  assert.equal(report.dev_profile.id, PROFILE_ID);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(PROFILE_TOKEN));
});

test("status warns when the running editor rejects the profile token", async () => {
  const fs = installedCheckout();
  const endpoint = fakeEndpoint({ token: "server-was-started-with-another-token" });
  const report = await checkOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, fetchImpl: endpoint.fetch });

  assert.equal(report.status, "warning");
  assert.equal(report.mcp.reason, "token_rejected");
  assert.ok(report.notes.some((note) => /different OPENCHATCUT_MCP_TOKEN/.test(note)));
});

test("start runs the editor's npm script under Node 24 with our roots in .env.local", async () => {
  const fs = installedCheckout({ envLocal: null });
  const spawner = fakeSpawn();
  const started = [];
  const code = await startOpenChatCut({
    workspaceRoot: WORKSPACE,
    env: { PATH: "/usr/bin", OPENCHATCUT_MCP_TOKEN: "pinned-token-value" },
    homeDir: HOME,
    fs,
    spawnImpl: spawner.spawn,
    onStart: (info) => started.push(info),
  });

  assert.equal(code, 0);
  const [call] = spawner.calls;
  const nodeBin = join(HOME, ".nvm", "versions", "node", "v24.19.0", "bin");
  assert.equal(call.command, join(nodeBin, "node"));
  assert.deepEqual(call.args.slice(1), ["run", "dev"]);
  assert.match(call.args[0], /npm-cli\.js$/);
  assert.equal(call.options.cwd, CHECKOUT);
  assert.equal(call.options.env.PATH, `${nodeBin}:/usr/bin`);
  assert.equal(call.options.env.OPENCHATCUT_MCP_TOKEN, "pinned-token-value");
  assert.equal(started[0].env_local.created, true);
  assert.equal(started[0].token_source, "env");

  await startOpenChatCut({ workspaceRoot: WORKSPACE, env: { PATH: "" }, homeDir: HOME, fs, spawnImpl: spawner.spawn, desktop: true });
  assert.deepEqual(spawner.calls[1].args.slice(1), ["run", "desktop:dev"]);
});

test("start refuses to run without an installed checkout or Node 24", async () => {
  await assert.rejects(
    startOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs: memoryFs(), spawnImpl: fakeSpawn().spawn }),
    /openchatcut install/,
  );
  await assert.rejects(
    startOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, homeDir: "/nowhere", fs: installedCheckout(), spawnImpl: fakeSpawn().spawn }),
    /Node 24/,
  );
});

test("connect registers the endpoint in Claude Code's local scope with the bearer header, redacted in output", async () => {
  const fs = installedCheckout();
  const spawner = fakeSpawn({ stdout: `Added HTTP MCP server openchatcut with Bearer ${PROFILE_TOKEN}\n` });
  const result = await connectClaudeCode({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, spawnImpl: spawner.spawn });

  assert.equal(result.ok, true);
  assert.equal(result.token_source, "profile");
  assert.equal(result.endpoint, OPENCHATCUT_DEFAULT_ENDPOINT);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PROFILE_TOKEN));
  assert.match(result.output, /\[redacted\]/);

  const [remove, add] = spawner.calls;
  assert.deepEqual(remove.args, ["mcp", "remove", "-s", "local", "openchatcut"]);
  assert.equal(add.command, "claude");
  // Name and URL precede the variadic -H options, or the CLI reads them as header values.
  assert.deepEqual(add.args.slice(0, 8), ["mcp", "add", "-s", "local", "-t", "http", "openchatcut", OPENCHATCUT_DEFAULT_ENDPOINT]);
  assert.deepEqual(add.args.slice(8, 10), ["-H", `Authorization: Bearer ${PROFILE_TOKEN}`]);
  assert.ok(add.args.includes("x-openchatcut-mcp-client: claude-code"));
  assert.equal(add.options.cwd, WORKSPACE);
  assert.match(result.codex.command, /--bearer-token-env-var OPENCHATCUT_MCP_TOKEN/);
});

test("connect stops without a token instead of registering a broken entry", async () => {
  const spawner = fakeSpawn();
  await assert.rejects(
    connectClaudeCode({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs: installedCheckout({ token: null }), spawnImpl: spawner.spawn }),
    /No OpenChatCut MCP token/,
  );
  assert.equal(spawner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Real-project helpers: import and render through fresh transports.

/**
 * A fake editor that behaves like the real one where it matters for these
 * helpers: every mutation of the live project (finalize, apply) bumps the
 * revision, and a transport bound to an older revision is refused as stale.
 */
function fakeEditor({ token = PROFILE_TOKEN, projectId = "p1", renderStatuses = ["rendering", "completed"] } = {}) {
  const state = { revision: 1, sessions: new Map(), transports: new Map(), uploads: 0, finalized: [], renders: [], calls: [] };
  let nextId = 1;
  const sessionOf = (headers) => state.transports.get(headers["mcp-session-id"]);
  const reply = (id, structuredContent) =>
    response({ body: sse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } }) });
  const rejected = (id, message, outcome = "rejected") =>
    response({ body: sse({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ outcome, message }) }] } }) });

  async function fetch(url, init) {
    if (String(url).includes("/upload?")) {
      state.uploads += 1;
      state.calls.push(["upload", init.headers["content-type"], init.headers["content-length"]]);
      return { ok: true, status: 200, async json() { return { receipt: `receipt-${state.uploads}`, assetType: "video", bytes: Number(init.headers["content-length"]) }; } };
    }
    if (init.method === "DELETE") {
      state.transports.delete(init.headers["mcp-session-id"]);
      return response({ status: 200, body: "" });
    }
    if (init.headers.authorization !== `Bearer ${token}`) return response({ status: 403, body: "{}", headers: { "content-type": "application/json" } });
    const message = JSON.parse(init.body);
    if (message.method === "initialize") {
      const id = `transport-${nextId++}`;
      state.transports.set(id, { boundRevision: null });
      return response({ headers: { "mcp-session-id": id }, body: sse({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "openchatcut", version: "1.0.0" } } }) });
    }
    if (message.method === "notifications/initialized") return response({ status: 202, body: "" });
    const transport = sessionOf(init.headers);
    const { name, arguments: args } = message.params;
    state.calls.push([name, args]);
    if (name === "target_project") {
      transport.boundRevision = state.revision;
      return reply(message.id, { ok: true, bindingMode: "browser", binding: { projectId, baseRevision: `v${state.revision}` }, editorUrl: `http://localhost:5199/#/editor/${projectId}` });
    }
    if (name === "discard_edit_session") {
      // Like the real runtime: a discard needs no binding check, so a helper can
      // always let go of its own draft even after the revision moved on.
      const session = state.sessions.get(args.editSessionId);
      if (session && session.status === "drafting") session.status = "discarded";
      return reply(message.id, session ?? {});
    }
    if (transport.boundRevision !== state.revision && name !== "get_edit_session") {
      for (const session of state.sessions.values()) if (session.status === "drafting") session.status = "stale";
      return rejected(message.id, `Project ${projectId} changed; re-initialize the MCP session.`, "stale");
    }
    if (name === "begin_edit_session") {
      const active = [...state.sessions.values()].find((session) => session.status === "drafting");
      if (active) return rejected(message.id, "An edit session is already active. Call list_edit_sessions to inspect it before recovery or discard.");
      const session = { editSessionId: `session-${nextId++}`, status: "drafting", approvalMode: args.approvalMode, ownerOnline: true, orphaned: false, recoveryActions: [] };
      state.sessions.set(session.editSessionId, session);
      return reply(message.id, session);
    }
    if (name === "list_edit_sessions") return reply(message.id, { result: [...state.sessions.values()] });
    if (name === "recover_edit_session") {
      const session = state.sessions.get(args.editSessionId);
      if (!session?.orphaned) return rejected(message.id, "Only an orphaned edit session can be recovered.");
      session.status = "cancelled";
      return reply(message.id, session);
    }
    if (!args.editSessionId || state.sessions.get(args.editSessionId)?.status !== "drafting") {
      return rejected(message.id, "editSessionId is required");
    }
    if (name === "import_media") {
      return reply(message.id, { ok: true, slots: [{ assetId: `asset-${state.uploads + 1}`, uploadUrl: `http://localhost:5199/upload?name=${encodeURIComponent(args.filename)}&handoff=h${state.uploads + 1}`, method: "POST" }] });
    }
    if (name === "finalize_uploaded_asset") {
      state.revision += 1;
      const asset = { ok: true, assetId: `asset-${state.finalized.length + 1}`, name: "S001-T003.mp4", src: "/media/uploads/asset.mp4", contentHash: "b5a1e5c7", durationInFrames: 91, width: 720, height: 1280, receipt: args.receipt, durationInSeconds: args.durationInSeconds };
      state.finalized.push(asset);
      return reply(message.id, asset);
    }
    if (name === "read_timeline") return reply(message.id, { fps: 24, tracks: [], items: [{ id: "item-1", trackId: "track_v1", kind: "video", startFrame: 0, durationInFrames: 91 }] });
    if (name === "submit_render_job") {
      state.revision += 1;
      state.renders.push(args);
      return reply(message.id, { renderId: "render-1" });
    }
    if (name === "track_export") {
      const status = renderStatuses.shift() ?? "completed";
      return reply(message.id, status === "completed"
        ? { status, progress: 1, downloadUrl: "/media/uploads/openchatcut-export-job-1.mp4" }
        : { status, progress: 0.4 });
    }
    return rejected(message.id, `unexpected tool ${name}`);
  }
  return { state, fetch };
}

test("media types for the upload slot follow the file extension", () => {
  assert.deepEqual(mediaTypeForFile("/takes/S001-T003.mp4"), { asset_type: "video", content_type: "video/mp4" });
  assert.deepEqual(mediaTypeForFile("bed.WAV"), { asset_type: "audio", content_type: "audio/wav" });
  assert.deepEqual(mediaTypeForFile("logo.svg"), { asset_type: "svg", content_type: "image/svg+xml" });
  assert.throws(() => mediaTypeForFile("notes.txt"), /Unsupported media file/);
});

test("import uploads each take through its own transport and checks the editor's content hash", async () => {
  const editor = fakeEditor();
  const fs = installedCheckout();
  fs.store.set("/takes/S001-T003.mp4", "take-bytes");
  const result = await importIntoOpenChatCut({
    workspaceRoot: WORKSPACE,
    env: {},
    homeDir: HOME,
    fs,
    fetchImpl: editor.fetch,
    projectId: "p1",
    files: ["/takes/S001-T003.mp4"],
    probe: async () => ({ duration_seconds: 3.042, video: { width: 720, height: 1280, frame_rate: 24 }, audio: { codec: "aac" } }),
    hashFile: async () => "b5a1e5c7",
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].asset_id, "asset-1");
  assert.equal(result.imported[0].content_hash_matches, true);
  assert.equal(result.imported[0].duration_in_frames, 91);
  const finalize = editor.state.calls.find(([name]) => name === "finalize_uploaded_asset")[1];
  assert.equal(finalize.durationInSeconds, 3.042);
  assert.equal(finalize.assetType, "video");
  assert.equal(finalize.hasAudioTrack, true);
  assert.deepEqual(editor.state.calls.find(([name]) => name === "upload"), ["upload", "video/mp4", "10"]);
  // The helper's own session is discarded and its transport closed afterwards.
  assert.ok([...editor.state.sessions.values()].every((session) => session.status !== "drafting"));
  assert.equal(editor.state.transports.size, 0);
});

test("import discards an orphaned draft left behind by a crashed client before starting", async () => {
  const editor = fakeEditor();
  editor.state.sessions.set("stale-1", { editSessionId: "stale-1", status: "drafting", ownerOnline: false, orphaned: true, recoveryActions: ["resume", "discard"] });
  const fs = installedCheckout();
  fs.store.set("/takes/a.mp4", "a");
  const result = await importIntoOpenChatCut({
    workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, fetchImpl: editor.fetch, projectId: "p1", files: ["/takes/a.mp4"],
    probe: async () => ({ duration_seconds: 1, video: { width: 720, height: 1280, frame_rate: 24 }, audio: null }),
    hashFile: async () => "x",
  });
  assert.equal(result.imported[0].asset_id, "asset-1");
  assert.equal(editor.state.sessions.get("stale-1").status, "cancelled");
  assert.ok(editor.state.calls.some(([name, args]) => name === "recover_edit_session" && args.action === "discard"));
});

test("import stops when the active draft belongs to a live client", async () => {
  const editor = fakeEditor();
  editor.state.sessions.set("live-1", { editSessionId: "live-1", status: "drafting", ownerOnline: true, orphaned: false, recoveryActions: [] });
  const fs = installedCheckout();
  fs.store.set("/takes/a.mp4", "a");
  await assert.rejects(
    importIntoOpenChatCut({
      workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, fetchImpl: editor.fetch, projectId: "p1", files: ["/takes/a.mp4"],
      probe: async () => ({ duration_seconds: 1, video: null, audio: null }),
      hashFile: async () => "x",
    }),
    /belongs to a live client/,
  );
});

test("render reads the timeline, submits, polls in a fresh transport, and names the file on disk", async () => {
  const editor = fakeEditor({ renderStatuses: ["rendering", "rendering", "completed"] });
  const fs = installedCheckout();
  let clock = 0;
  const result = await renderInOpenChatCut({
    workspaceRoot: WORKSPACE,
    env: {},
    homeDir: HOME,
    fs,
    fetchImpl: editor.fetch,
    projectId: "p1",
    name: "E002-v1.mp4",
    timelineOutPath: "projects/acme/V001/edits/E002-timeline.json",
    timeoutSeconds: 600,
    now: () => (clock += 1000),
  });

  assert.equal(result.render_id, "render-1");
  assert.equal(result.status, "completed");
  assert.equal(result.download_url, "http://localhost:5199/media/uploads/openchatcut-export-job-1.mp4");
  assert.equal(result.media_path, join(HOME, ".openchatcut", "dev-profiles", PROFILE_ID, "media", "uploads", "openchatcut-export-job-1.mp4"));
  assert.equal(result.timeline_items, 1);
  assert.match(fs.store.get(join(WORKSPACE, "projects/acme/V001/edits/E002-timeline.json")), /"fps": 24/);
  assert.deepEqual(editor.state.renders[0], { editSessionId: editor.state.renders[0].editSessionId, format: "video", codec: "h264", name: "E002-v1.mp4", saveToMediaPool: false });
  // Submitting moved the revision; polling still worked because it bound afresh.
  assert.equal(editor.state.calls.filter(([name]) => name === "track_export").length, 3);
  assert.equal(editor.state.calls.filter(([name]) => name === "target_project").length, 2);
});

test("render gives up with the last status when the deadline passes", async () => {
  const editor = fakeEditor({ renderStatuses: ["rendering", "rendering", "rendering", "rendering"] });
  let clock = 0;
  await assert.rejects(
    renderInOpenChatCut({
      workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs: installedCheckout(), fetchImpl: editor.fetch, projectId: "p1",
      timeoutSeconds: 2, now: () => (clock += 1500),
    }),
    /did not finish within 2s \(last status: rendering\)/,
  );
});

test("helpers refuse a project that no editor tab has open", async () => {
  const editor = fakeEditor();
  const original = editor.fetch;
  const fetchImpl = async (url, init) => {
    const message = init.body ? JSON.parse(init.body) : null;
    if (message?.params?.name === "target_project") {
      return response({ body: sse({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { ok: true, bindingMode: "offline", editorUrl: "http://localhost:5199/#/editor/p1" }, content: [] } }) });
    }
    return original(url, init);
  };
  await assert.rejects(
    withEditSession({ token: PROFILE_TOKEN, fetchImpl, projectId: "p1" }, async () => "unreachable"),
    /not open in a connected editor tab/,
  );
});

// ---------------------------------------------------------------------------
// Detached lifecycle: up / stop / open.

/** A fetch that refuses until the editor "boots", then answers like fakeEndpoint. */
function bootingEndpoint({ refusals = 2, ...options } = {}) {
  const endpoint = fakeEndpoint(options);
  let attempts = 0;
  return {
    endpoint,
    async fetch(url, init) {
      const message = init.body ? JSON.parse(init.body) : null;
      if (message?.method === "initialize" && attempts < refusals) {
        attempts += 1;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
      return endpoint.fetch(url, init);
    },
  };
}

/** A detached child with a pid; records whether it was unref'd. */
function detachedSpawn({ pid = 4242 } = {}) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.pid = pid;
      child.unref = () => {
        child.unrefd = true;
      };
      calls.push({ command, args, options, child });
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  };
}

/** Process table stub: kill(pid, 0) probes liveness, signals are recorded. */
function processTable(alive = []) {
  const living = new Set(alive);
  const signals = [];
  return {
    signals,
    living,
    kill(pid, signal) {
      const target = Math.abs(pid);
      if (!living.has(target)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === 0) return true;
      signals.push([pid, signal]);
      if (signal === "SIGTERM" || signal === "SIGKILL") living.delete(target);
      return true;
    },
  };
}

const noSleep = async () => {};

test("up starts the editor detached, waits for the endpoint, opens the project tab and waits for binding", async () => {
  const roots = resolveOpenChatCutPaths({ workspaceRoot: WORKSPACE, env: {} }).importRoots;
  const fs = installedCheckout({ envLocal: `AGENT_IMPORT_ROOTS=${roots.join(",")}\n` });
  const status = { connectedProjectIds: [] };
  const booting = bootingEndpoint({ refusals: 3, status });
  const spawner = detachedSpawn();
  const opened = [];
  let clock = 0;
  const result = await upOpenChatCut({
    workspaceRoot: WORKSPACE,
    env: { PATH: "/usr/bin" },
    homeDir: HOME,
    fs,
    fetchImpl: booting.fetch,
    spawnImpl: spawner.spawn,
    openLog: () => 7,
    opener: async (url) => {
      opened.push(url);
      status.connectedProjectIds = ["p1"]; // the tab loads and the editor registers its tools
    },
    killImpl: processTable().kill,
    sleep: noSleep,
    now: () => (clock += 1000),
    projectId: "p1",
  });

  assert.equal(result.started, true);
  assert.equal(result.pid, 4242);
  assert.equal(result.project_bound, true);
  assert.equal(result.editor_url, "http://localhost:5199/#/editor/p1");
  assert.deepEqual(opened, ["http://localhost:5199/#/editor/p1"]);
  assert.equal(result.log_path, join(WORKSPACE, ".openchatcut-editor", "editor.log"));
  assert.equal(fs.store.get(join(WORKSPACE, ".openchatcut-editor", "editor.pid")), "4242\n");
  const [call] = spawner.calls;
  assert.deepEqual(call.args.slice(-2), ["run", "dev"]);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio, ["ignore", 7, 7]);
  assert.equal(call.options.env.BROWSER, "none");
  assert.equal(call.options.cwd, CHECKOUT);
  assert.equal(call.child.unrefd, true);
});

test("up is idempotent: a running, authorized editor is reported and nothing is spawned", async () => {
  const fs = installedCheckout();
  fs.store.set(join(WORKSPACE, ".openchatcut-editor", "editor.pid"), "777\n");
  const endpoint = fakeEndpoint({ status: { connectedProjectIds: ["p1"] } });
  const spawner = detachedSpawn();
  const opened = [];
  const result = await upOpenChatCut({
    workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs, fetchImpl: endpoint.fetch, spawnImpl: spawner.spawn,
    opener: async (url) => opened.push(url), killImpl: processTable([777]).kill, sleep: noSleep, projectId: "p1",
  });
  assert.equal(result.already_running, true);
  assert.equal(result.pid, 777);
  assert.equal(result.project_bound, true);
  assert.deepEqual(spawner.calls, []);
  assert.deepEqual(opened, [], "a bound project is not reopened");
});

test("up refuses to start a second editor next to one that rejects our token", async () => {
  const endpoint = fakeEndpoint({ token: "someone-elses-token-value-that-is-long-enough" });
  const spawner = detachedSpawn();
  await assert.rejects(
    upOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, homeDir: HOME, fs: installedCheckout(), fetchImpl: endpoint.fetch, spawnImpl: spawner.spawn, sleep: noSleep }),
    /rejects our token/,
  );
  assert.deepEqual(spawner.calls, []);
});

test("waiting for the editor and for a binding give up with a readable reason", async () => {
  let clock = 0;
  await assert.rejects(
    waitForEditor({ resolveToken: async () => PROFILE_TOKEN, fetchImpl: refusingFetch(), timeoutMs: 3000, sleep: noSleep, now: () => (clock += 2000) }),
    /did not become ready within 3s \(last: not_running/,
  );
  const endpoint = fakeEndpoint({ status: { connectedProjectIds: [] } });
  clock = 0;
  await assert.rejects(
    waitForBinding({ token: PROFILE_TOKEN, projectId: "p1", fetchImpl: endpoint.fetch, timeoutMs: 3000, sleep: noSleep, now: () => (clock += 2000) }),
    /No editor tab opened project p1 within 3s; open http:\/\/localhost:5199\/#\/editor\/p1/,
  );
});

test("stop signals the process group of an editor that up started and clears the pid file", async () => {
  const fs = installedCheckout();
  const pidPath = join(WORKSPACE, ".openchatcut-editor", "editor.pid");
  fs.store.set(pidPath, "4242\n");
  const table = processTable([4242]);
  const result = await stopOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, fs, fetchImpl: refusingFetch(), killImpl: table.kill, sleep: noSleep });
  assert.deepEqual(result, { stopped: true, pid: 4242, forced: false });
  assert.deepEqual(table.signals, [[-4242, "SIGTERM"]]);
  assert.equal(fs.store.has(pidPath), false);
});

test("stop leaves an editor it did not start alone and reports a stale pid file", async () => {
  const running = await stopOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, fs: installedCheckout(), fetchImpl: fakeEndpoint().fetch, killImpl: processTable().kill, sleep: noSleep });
  assert.equal(running.stopped, false);
  assert.equal(running.reason, "not_managed");

  const fs = installedCheckout();
  const pidPath = join(WORKSPACE, ".openchatcut-editor", "editor.pid");
  fs.store.set(pidPath, "999\n");
  const stale = await stopOpenChatCut({ workspaceRoot: WORKSPACE, env: {}, fs, fetchImpl: refusingFetch(), killImpl: processTable().kill, sleep: noSleep });
  assert.deepEqual(stale, { stopped: false, reason: "not_running" });
  assert.equal(fs.store.has(pidPath), false);
});

test("open resolves the editor tab URL for a project or the dashboard", async () => {
  const opened = [];
  const opener = async (url) => opened.push(url);
  assert.deepEqual(await openOpenChatCut({ env: {}, projectId: "p1", opener }), { opened: "http://localhost:5199/#/editor/p1" });
  assert.deepEqual(await openOpenChatCut({ env: {}, opener }), { opened: "http://localhost:5199" });
  assert.deepEqual(opened, ["http://localhost:5199/#/editor/p1", "http://localhost:5199"]);
});
