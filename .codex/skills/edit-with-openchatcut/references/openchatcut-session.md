# OpenChatCut session and hand-off reference

Verified on 2026-09-05 against the OpenChatCut checkout at `../OpenChatCut` (v0.2.14, external
skill baseline `2026-09-04.1`, MCP server version 1.0.0) with a live import → place → apply →
render → adopt run. Tool schemas are served live by the MCP server; when a shape below disagrees
with the live schema, the live schema wins and this file needs updating.

## Editor lifecycle from the CLI

| Command | Effect |
| --- | --- |
| `openchatcut up [--project-id <id>] [--open] [--no-wait] [--desktop] [--timeout-seconds 180]` | idempotent start: probes the endpoint; if nothing answers, spawns `npm run dev` detached under Node 24 with `BROWSER=none`, writes `.openchatcut-editor/editor.pid`, logs to `.openchatcut-editor/editor.log`, waits for an authorized endpoint (the token is minted by the first probe); with `--project-id` opens the tab and waits for `connectedProjectIds` |
| `openchatcut stop` | SIGTERM to the process group `up` started (npm and vite together), SIGKILL after 15 s; an editor started elsewhere is reported as `not_managed` and left running |
| `openchatcut open [--project-id <id>]` | opens the tab through the desktop opener (`open`, `xdg-open`, `start`) |
| `openchatcut start [--desktop]` | the same server in the foreground, for a terminal the user watches |

`up` refuses to start when an endpoint answers but rejects our token: that is another checkout
or another `OPENCHATCUT_MCP_TOKEN`, and a second server on the same port would fail anyway.

## Transport staleness

A transport binds to the project revision at `target_project`. Every editor call is checked
against the current revision; after any live change (`finalize_uploaded_asset`,
`review_edit_session` applying, `submit_render_job`) the next call answers
`{"outcome":"stale","message":"Project … changed; re-initialize the MCP session."}`, the server
closes the transport, and the active draft is marked stale. Consequences:

- real-project steps belong in `node src/cli.mjs openchatcut import` / `render`, which open a
  fresh transport per step and discard their own zero-operation sessions afterwards;
- an agent connection that went stale must reconnect (`/mcp` → reconnect `openchatcut` in
  Claude Code) before any further call;
- a draft whose owner disappeared shows up in `list_edit_sessions` as `orphaned: true` with
  `recoveryActions: ["resume", "discard"]`; while the owner transport is alive it shows
  `ownerOnline: true` and cannot be recovered by anyone else (the editor evicts idle
  transports after 60 minutes; restarting `npm run editor` orphans them at once).

Tool calls that carry `editSessionId` (all editor tools, real-project tools included) are
the ones held to the bound revision; `list_projects`, `create_project`, `target_project`,
`get_editor_url`, `load_skill` and `openchatcut_status` are not.

## Endpoint and tool tiers

- Endpoint: `http://localhost:5199/api/external-mcp/mcp` (Streamable HTTP). Every request
  carries `Authorization: Bearer <token>`; a missing or wrong token answers HTTP 403.
- Without a connected editor tab the server exposes a **server-direct** tier (31 tools): session
  controls, `read_project`, `read_timeline`, item/track edits, script and caption edits,
  `import_timeline`. Upload, render, export, generation, visual inspection and manual approval
  need a **browser-bound** project: open the `editorUrl`, then the editor registers its tools.
- `openchatcut_status` reports `connectedProjectIds`, `editors`, `toolCount` and
  `browserRequiredFor`. `list_projects` and `create_project` work without a browser.

## Session lifecycle

| Step | Tool | Notes |
| --- | --- | --- |
| bind | `target_project { projectId }` | returns `bindingMode` (`browser` or `offline`) and `editorUrl` |
| open | `begin_edit_session { clientName, approvalMode }` | `manual` (default) or `auto`; keep `editSessionId` |
| read | `read_project`, `read_timeline` | pass `editSessionId`; draft edits are visible only inside the session |
| edit | draft-safe tools | every call carries `editSessionId` |
| finish | `review_edit_session { editSessionId, summary }` | manual: proposal card in the editor; auto: applied immediately |
| confirm | `get_edit_session { editSessionId }` | terminal: `applied`, `rejected`, `cancelled`, `stale`, `failed`, `discarded` |
| abandon | `discard_edit_session` | leaves the live project untouched |

An offline binding (no browser owns the stored project) requires `approvalMode: "auto"` and
only server-direct tools; use it for data-only fixes the user has explicitly approved.

## Project creation

`create_project { name, compositionWidth, compositionHeight, fps }` — defaults 1920x1080 and
30 fps. Pass the frozen plan's frame (for 9:16 at 24 fps: 1080, 1920, 24) or the adopted master
fails on ratio and frame rate. `manage_timelines` (`update` with `ratio` or `width`+`height`)
and `set_aspect_ratio` retarget an existing timeline; neither changes fps.

## `read_timeline` snapshot

```jsonc
{
  "fps": 24,
  "tracks": [{ "id": "track_v1", "alias": "V1", "trackType": "video" }, { "id": "track_a1", "alias": "A1", "trackType": "audio" }],
  "items": [
    {
      "id": "item_…", "trackId": "track_v1", "name": "S001-T003.mp4", "kind": "video",
      "startFrame": 0, "durationInFrames": 91,
      "sourceAssetId": "…", "props": {}, "effects": []
    }
  ]
}
```

`edit_item` answers `{ ok, atomic, results: [{ ok, kind, placed: { assetId, itemId, name, track,
startFrame, durationInFrames } }] }`; `review_edit_session` in auto mode answers the session
record with `status: "applied"` and `appliedOperationCount`.

Save it verbatim (`projects/<client>/VNNN/edits/E00N-openchatcut-timeline-v1.json`) before
rendering: `adopt-master --timeline` derives the cut list from `items` on the track carrying
the most visual frames, keeps gaps as segments, and compares the total frame count with the
export.

## Bringing files in (web editor)

`import_media` opens a single-use upload slot bound to the declared byte size and MIME type:

```jsonc
// tools/call import_media (editSessionId is required, like every editor tool)
{ "editSessionId": "…", "action": "create_session", "assetType": "video", "filename": "S001-T001.mp4",
  "contentType": "video/mp4", "size": 18342211 }
// → { "ok": true, "sessionId": "sess_…", "state": "awaiting_upload",
//     "slots": [ { "assetId": "…", "readUrl": "/media/uploads/<assetId>.<sessionId>.mp4",
//                  "uploadUrl": "http://localhost:5199/upload?name=…&sessionId=…&assetId=…&assetType=video&projectId=…&handoff=…",
//                  "method": "POST", "headers": { "Content-Type": "video/mp4", "Content-Length": "18342211" },
//                  "expiresInSeconds": 300 } ],
//     "next": [ "Upload once to the exact slot uploadUrl before expiry…", "Pass the opaque receipt…" ] }
```

Upload the exact bytes to `slots[0].uploadUrl` (already absolute) within five minutes; the
handoff token in the URL authorises this one request and no bearer header is needed:

```bash
curl -sS -X POST -H "Content-Type: video/mp4" -H "Content-Length: $(stat -f%z S001-T001.mp4)" \
  --data-binary @S001-T001.mp4 "<slots[0].uploadUrl>"
```

The JSON reply carries an opaque `receipt`. Finish with `finalize_uploaded_asset`:

```jsonc
{ "receipt": "…", "assetType": "video", "durationInSeconds": 4.0, "width": 1080, "height": 1920,
  "fps": 24, "hasAudioTrack": true }
```

Duration, width, height and fps come from `ffprobe` on the source. The finalize reply carries
`assetId`, `src` (`/media/uploads/<assetId>.<sessionId>.mp4`), `contentHash` (sha256 of the
bytes, identical to the file's own sha256), `durationInFrames`, `width` and `height`.
`import_media` and `finalize_uploaded_asset` are real-project tools: in a `manual` session the
editor shows a confirmation card, in an `auto` session they run directly. Finalizing moves the
project revision, which is why `node src/cli.mjs openchatcut import --project-id <id>
--files <a,b,c>` does one file per transport and reports `content_hash_matches`. Desktop builds
can use `import_asset` / `import_folder` on paths inside `AGENT_IMPORT_ROOTS` instead.

Public URLs go through `download_media`; this project's takes are local files, so they do not.

A finalized asset is placed on the timeline with `edit_item` inside the edit session:

```jsonc
{ "editSessionId": "…", "adds": [
  { "type": "video", "assetId": "<pool asset id>", "track": "V1", "fromFrame": 0 },
  { "type": "video", "assetId": "<next asset id>", "track": "V1", "fromFrame": 96, "durationInFrames": 96,
    "sourceStartSeconds": 0.125 }
] }
```

Video track aliases count bottom-up (`V1` is the bottom video track). Entries run
adds → updates → deletes against one draft and publish only when every entry is valid.

## Rendering and exporting

```jsonc
// tools/call submit_render_job
{ "format": "video", "codec": "h264", "name": "ACME-V001-E002-v1.mp4", "saveToMediaPool": false }
// → { "renderId": "…" }

// tools/call track_export (bounded wait; the MCP bridge caps timeoutSeconds at 45)
{ "action": "wait", "renderIds": "<renderId>", "timeoutSeconds": 45 }
// → { "status": "completed", "progress": 1, "downloadUrl": "/media/uploads/<file>.mp4", … }
```

Repeat `track_export` while `status` is not terminal. The finished file is
`openchatcut-export-job-<id>.mp4` in the editor's dev profile (`openchatcut status` →
`dev_profile.media_uploads_dir`) and is swept when stale, so adopt it promptly. `submit_export`
is the synchronous variant and also produces SRT/TXT captions and FCPXML;
`read_export_history` lists earlier exports.

`node src/cli.mjs openchatcut render --project-id <id> --name <file.mp4> --timeline-out <json>`
does the whole sequence (snapshot, submit, bounded polling in a second transport because the
submit moves the revision) and returns `render_id`, `download_url`, `media_path` and
`timeline_path`, ready for `adopt-master`. Optional `--codec vp8`, `--resolution 1080p`,
`--fps 24`, `--timeout-seconds 900`, `--save-to-media-pool`.

Sound: the editor's `normalize_loudness` defaults to -14 LUFS; pass `target: -17` to land inside
this project's `[-20, -16]` window, or the adopted master comes back `review_required` on
loudness (a raw generated take measured -27.7 LUFS in the verification run).

## Adopting the master

```bash
node src/cli.mjs adopt-master --project projects/acme/V001 --variant E002 \
  --url http://localhost:5199/media/uploads/<file>.mp4 \
  --timeline projects/acme/V001/edits/E002-openchatcut-timeline-v1.json \
  --renderer-project <openchatcut project id> --render-id <renderId> \
  --note "OpenChatCut cut: transitions on S002/S003, styled captions"
```

`--file <path>` replaces `--url` for a file already on disk. Only `localhost` URLs are accepted.
Adopting identical bytes twice returns the existing report (`reused: true`); different bytes get
the next version. Files written to `artifacts/<client>/VNNN/masters/E002/`:

| File | Content |
| --- | --- |
| `E002-master-vN.mp4` | the export, byte-for-byte |
| `E002-master-vN.timeline.json` | the `read_timeline` snapshot |
| `E002-master-vN.cutlist.json` | `{ output: { frame_rate }, segments: [{ id, frames, … }] }` for `scripts/analyse-master.mjs` |
| `E002-master-vN.report.json` | see below |

Report contract (`schema: "adopted-master/1"`):

```jsonc
{
  "variant_id": "E002", "project_id": "ACME-V001",
  "master_path": "…/E002-master-v1.mp4", "master_sha256": "…", "version": "v1", "reused": false,
  "origin": { "renderer": "openchatcut", "renderer_project_id": "…", "render_id": "…",
              "source_url": "http://localhost:5199/media/uploads/….mp4", "source_sha256": "…",
              "note": "…", "adopted_at": "2026-09-05T12:00:00.000Z" },
  "timeline_path": "…", "cut_list_path": "…",
  "cut_list": { "fps": 24, "base_track": "…", "segments": [ { "id": "…", "frames": 96, "start_frame": 0, "source_asset_id": "…" } ],
                "total_frames": 192, "warnings": [] },
  "review_binding": "unbound",
  "plan_checked": true,
  "verification": {
    "duration_seconds": 8.0, "frames": 192,
    "video": { "codec": "h264", "width": 1080, "height": 1920, "frame_rate": 24 },
    "audio": { "codec": "aac", "sample_rate": 48000, "channels": 2 },
    "loudness": { "integrated_lufs": -17.1, "true_peak_dbtp": -1.6, "lra": 4.2 },
    "target_lufs": [-20, -16],
    "plan_checks": { "aspect_ratio": { "plan": "9:16", "master": "9:16" }, "frame_rate": { "plan": 24, "master": 24 },
                     "duration_seconds": { "plan": 8, "tolerance": 0.5, "master": 8.0 } },
    "black_stretches": [], "frozen_stretches": [],
    "issues": [], "warnings": [], "status": "ok"
  }
}
```

`issues` block delivery (`review_required`): ratio, frame rate or duration off the frozen plan,
frame count off the timeline snapshot, black stretches, loudness outside `target_lufs`
(default `[-20, -16]`, override with `--target-lufs`), true peak above -1 dBTP, or a missing
audio stream. `warnings` (frozen stretches, cut-list oddities) need a human verdict, not a rebuild.

## Recovery quick table

| Symptom | Cause | Action |
| --- | --- | --- |
| connection refused / `fetch failed` | editor not running | `node src/cli.mjs openchatcut up`, then reconnect the MCP server |
| HTTP 403 `invalid OpenChatCut MCP token` | token mismatch | `openchatcut connect`, or align `OPENCHATCUT_MCP_TOKEN` |
| tool not exposed | no editor tab bound | open `editorUrl`, `openchatcut_status`, refresh tools |
| `begin_edit_session` reports an active session | orphaned draft | `list_edit_sessions`, then `recover_edit_session` (`resume` or `discard`) |
| session `stale` | live project changed under the draft | report it; new session |
| upload 401 `invalid or expired upload handoff` | slot expired (5 min) or size/MIME mismatch | new `import_media` slot |
