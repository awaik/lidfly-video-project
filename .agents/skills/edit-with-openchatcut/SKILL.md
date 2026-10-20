---
name: edit-with-openchatcut
description: "Edit reviewed AI-generated takes interactively in OpenChatCut, the agent-native local editor installed next to this repository, through its MCP edit sessions, then bring the rendered export back into the project as a versioned, verified master. Use when a cut needs transitions, keyframes, styled captions, effects, colour, agent-driven timeline changes or a human review inside an editor that the deterministic edit manifest cannot express, or when the user asks to edit in OpenChatCut. Not for paid generation or for publishing."
---

# Edit With OpenChatCut

OpenChatCut is a local-first video editor that exposes its timeline to agents over MCP. In this
project it is the interactive editing route; the deterministic assembler (`$assemble-short-video`)
stays the default for reproducible delivery masters. A cut made here re-enters the project only
through `adopt-master`, which versions the export, records where it came from, and measures it.

## When to use which route

- **Assembler** (`node src/cli.mjs assemble`): cuts, overlays, ducked music, retiming, exact frame
  counts, reproducible from a manifest. Prefer it for delivery masters and for anything a manifest
  can express.
- **OpenChatCut**: transitions, keyframes, motion graphics, styled captions, effects, colour,
  multi-track layouts, transcript-driven trims, and any edit the user wants to review or adjust in
  an editor. Also the route the user names explicitly.
- Neither route generates footage: every standalone frame remains model footage. Do not replace a
  filmed screen with a rendered card in either editor.

## Entry contract

Require before touching the timeline:

- project context (`projects/<client>/VNNN`) with a frozen shot plan: its `target.aspect_ratio`,
  `frame_rate` and `duration_seconds_total` are what the adopted master is measured against;
- takes with `$review-generated-video` decisions; only accepted takes go into the editor;
- a running, connected editor: `node src/cli.mjs openchatcut up` brings it up and binds the
  project tab (see below), and the MCP server `openchatcut` must be available to the agent;
- the user's decision on `approvalMode`: `manual` (default, the user approves the proposal in
  the editor) or `auto` (applies at review time; only when the user explicitly asks).

Do not start an edit session to "see what it does" on a client project without a task.

## Install it when it is missing

OpenChatCut is not part of this repository. When `openchatcut status` or `up` reports the
checkout as absent (`checkout.present: false`), install it yourself; it is a local, free
action that only needs git, Node 24 and network time:

```bash
node src/cli.mjs openchatcut install   # clones https://github.com/0xsline/OpenChatCut.git into ../OpenChatCut
node src/cli.mjs openchatcut connect   # once per machine: registers the MCP server in Claude Code
```

`install` writes the checkout's `.npmrc` (npm 12 otherwise refuses the lockfile's foreign-host
tarballs and the ffmpeg/ffprobe/Electron install scripts), runs `npm install` under Node 24 and
seeds `.env.local`. If Node 24 is missing, ask the user to run `nvm install 24` or to set
`OPENCHATCUT_NODE`; do not downgrade the editor's engine requirement. After a fresh install the
MCP server in Claude Code needs a reconnect once the editor is up. The full manual procedure and
the update path are in the README section "Установка OpenChatCut".

## Start it yourself

The editor is a local, free, reversible process: start it without asking. The first command of
any editor task is

```bash
node src/cli.mjs openchatcut up --project-id <editor project id>   # or without --project-id before create_project
```

It is idempotent: a running editor is reported, a stopped one is started detached (it survives
your session; pid and log live in `.openchatcut-editor/`), the command waits until the MCP
endpoint accepts the token, opens the project's tab in the default browser and waits until the
editor has registered its tools (`project_bound: true`). If the tab does not bind within the
timeout, the returned `editor_url` is what the user has to open. `openchatcut stop` ends only an
editor that `up` started; one started elsewhere is reported, not killed. If your MCP tools were
loaded while the editor was down, reconnect the `openchatcut` server after `up`.

Other commands:

```bash
node src/cli.mjs openchatcut status    # read-only: checkout, Node 24, deps, .env.local, token, endpoint
node src/cli.mjs openchatcut install   # clone ../OpenChatCut (if absent) and npm install under Node 24
node src/cli.mjs openchatcut open --project-id <id>   # (re)open a project tab
node src/cli.mjs openchatcut connect   # register the MCP endpoint in Claude Code local scope
npm run editor:foreground              # the same server in the foreground (Electron: --desktop)
```

The editor lives at `../OpenChatCut` (override with `OPENCHATCUT_DIR`), listens on
`http://localhost:5199`, and serves MCP at `/api/external-mcp/mcp`. The endpoint always requires a
bearer token; `connect` reads it from the editor's dev profile (or `OPENCHATCUT_MCP_TOKEN`) and
never prints it. Never paste the token into chat, manifests, reports or the repository.
`.mcp.json` in the repository declares the same server and expects `OPENCHATCUT_MCP_TOKEN`
exported in the shell; the local-scope entry written by `connect` takes precedence.

`up` and `start` also seed the editor's `.env.local` from its example file and list this
workspace's `artifacts/`, `projects/` and `audio-library/` in `AGENT_IMPORT_ROOTS`, which the
desktop app uses for `import_asset` / `import_folder`.

Editor-side guidance (captions, transcription, motion graphics, export, verification) is served
by the editor itself: call `load_skill` over MCP. The upstream connection notes live in the
checkout at `../OpenChatCut/skills/openchatcut/references/`.

## Workflow

Read [the session and hand-off reference](references/openchatcut-session.md) for exact tool
arguments, upload commands and the adopted-master report.

One rule shapes the whole sequence: **every change to the live project (an import finalizing,
a draft being applied, a render being submitted) invalidates the MCP transport that was bound
before it.** The editor answers `stale` ("re-initialize the MCP session"), closes the transport,
and any draft it owned becomes orphaned. So real-project steps run through the CLI, which opens
a fresh transport per step, and the agent's own MCP connection is used for the creative draft
only. If your connection does go stale, reconnect the `openchatcut` server, then
`list_edit_sessions` and `recover_edit_session` (`discard`) the orphaned draft before
`begin_edit_session`.

### 1. Bind to a project at the plan's shape

1. `openchatcut_status`, then `list_projects`. Use an existing editor project only when the
   user names it or it clearly belongs to this VNNN.
2. Otherwise `create_project` with the frozen plan's frame: `name` (`ACME-V001 E002`),
   `compositionWidth`, `compositionHeight` and `fps`. The defaults are 1920x1080 at 30 fps, and
   a 9:16 / 24 fps plan rendered on them fails adoption on ratio and frame rate.
3. `node src/cli.mjs openchatcut up --project-id <id>` opens the project's tab and waits for the
   editor to register its tools; then `target_project` over MCP. Upload, render, visual
   inspection and manual approval need that connected tab; `openchatcut_status` shows
   `connectedProjectIds` once it is.

### 2. Bring accepted takes in

```bash
node src/cli.mjs openchatcut import --project-id <editor project id> \
  --files artifacts/<client>/VNNN/jobs/S001/T003-<hash>/outputs/result-01.mp4,artifacts/.../S002/...
```

One upload slot, upload and finalize per file, each in its own transport; the editor's content
hash is compared with the file's sha256 and reported (`content_hash_matches`). Files are read,
never moved. Only accepted takes, plus music, VO and graphics from `audio-library/` and the
project's `brief/` assets with the rights they carry there. In the Electron build
`import_folder` on a directory inside the allowed roots does the same in one call.

### 3. Draft the cut in an edit session

1. `begin_edit_session` with `clientName` and the agreed `approvalMode`; keep `editSessionId`.
   If it reports an active session, `list_edit_sessions` and discard only entries marked
   `orphaned`; a session with `ownerOnline: true` belongs to a live client.
2. `read_project` and `read_timeline` before the first mutation; re-read after any failure.
3. Place pool assets with `edit_item` `adds` (`{ type: "video", assetId, track: "V1",
   fromFrame }`), then shape the cut with the draft-safe tools (`move_item`, `set_item_timing`,
   `split_item`, `edit_track`, `edit_captions`, `apply_script`, `manage_markers`…), always
   passing `editSessionId`. `read_script` / `apply_script` round-trips a `timeline.md` for larger
   rearrangements. Use `view_timeline_frames` to check framing and caption placement against
   faces and the platform's bottom UI band, exactly as the finishing standard demands.
4. Level the sound before review: `normalize_loudness` with `target: -17` (the editor's own
   default is -14 LUFS, above this project's -20..-16 window).
5. `review_edit_session` with a short summary. In manual mode tell the user the proposal is
   waiting in the editor; poll `get_edit_session` and report `applied`, `rejected` or
   `discarded` verbatim. Never describe an edit as done before `applied`.

Keep the frozen plan's ratio and frame rate on the timeline; `set_aspect_ratio` only with the
user's format decision, as with any format change in this project.

### 4. Render and adopt

```bash
node src/cli.mjs openchatcut render --project-id <editor project id> --name <ACME-V001-E002-v1.mp4> \
  --timeline-out projects/<client>/VNNN/edits/E002-openchatcut-timeline-v1.json
```

It saves the `read_timeline` snapshot, submits an H.264 render of the active timeline at the
timeline's size and fps, waits for it, and returns `download_url` plus the file's path in the
editor's dev profile. Then adopt:

```bash
node src/cli.mjs adopt-master --project projects/<client>/VNNN --variant E002 \
  --url <download_url> --timeline projects/<client>/VNNN/edits/E002-openchatcut-timeline-v1.json \
  --renderer-project <editor project id> --render-id <render_id> --note "<what this cut is>"
```

It copies the export into `artifacts/<client>/VNNN/masters/E00N/` as the next `-master-vN`,
never overwriting, and writes a report with sha256, origin, a cut list derived from the
timeline and measured verification against the frozen plan and the loudness target. A
`review_required` status names the numbers that disagree; fix the timeline and render again
rather than editing the file. Then run `node scripts/analyse-master.mjs <master> <cutlist.json>`
and keep both records with the delivery.

## Rules

- Sources are read, never moved, trimmed or overwritten; every render is a new version.
- The report's `review_binding` is `unbound`: list the accepted take reviews the cut used in the
  hand-off so the binding is explicit.
- Loudness, true peak, ratio, frame rate and duration are reported as measured numbers; do not
  restate them as "passed".
- No upload, publication or paid generation from the editor. Its generation tools (`submit_video`,
  `submit_voice`, `submit_music`…) are outside this project's provider and budget gates; do not
  call them.
- `openchatcut import` and `render` run the editor's real-project tools in unattended (`auto`)
  sessions of their own: invoking the command is the approval, so invoke them only for the
  files and the timeline the user has decided on.
- One edit session at a time per project; a stale or orphaned session is recovered with
  `list_edit_sessions` / `recover_edit_session`, not by starting over silently.

## Recovery

- Connection refused: the editor is not running; `node src/cli.mjs openchatcut up`, then
  reconnect the MCP server if its tools were loaded while the editor was down. A start that
  never becomes ready is diagnosed from `.openchatcut-editor/editor.log`.
- `invalid OpenChatCut MCP token` / HTTP 403: `node src/cli.mjs openchatcut connect` (the dev
  profile token changed) or align `OPENCHATCUT_MCP_TOKEN` on both sides.
- Tool missing or "browser required": open the project's `editorUrl` and refresh the tool list.
- `stale` / "re-initialize the MCP session": the live project moved under the transport.
  Reconnect the server, discard the orphaned draft, begin a new session; nothing partial was
  applied.
- Session `stale`, `cancelled` or `failed`: it cannot resume; report it and begin a new session.
- `openchatcut import` / `render` refuse a project without a connected tab: open `editorUrl`.

## Hand-off

Return the editor project id and `editorUrl`, the session ids and their final statuses, the
assets imported with their take ids and review paths, the render id, the adopted master path
with version and sha256, the report's verification numbers and warnings, the analyse-master
findings, and anything still waiting for the user's approval in the editor.
