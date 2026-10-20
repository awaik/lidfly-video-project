---
name: generate-browser-video
description: "Generate video takes through the Gemini website in the selected browser profile, download originals into a production project, and hand them to review and assembly. Use when the user chooses browser generation instead of the video API."
---

# Generate Browser Video

Use Gemini's visible UI through the available computer/browser tool. This is a second production route, not an EVOLINK API adapter. Never use hidden endpoints, extracted cookies, or API keys to automate the website.

## Preparation

- Use `$produce-short-video` for bootstrap and `$develop-shot-plan` for the reviewed, frozen plan. Planning-only CLI/skill development needs no production bootstrap.
- Use the browser profile and Google account designated for the project at entry URL `https://gemini.google.com/videos`. Verify the profile and signed-in account in the UI before entering production prompts. A connected profile named Person 1 is not sufficient evidence of identity. Use native browser UI if that profile is not exposed through the browser connector.
- Set each browser shot's `route.model` to `gemini-browser`, with `text_to_video` or `image_to_video`, **before freeze**. This is a local route identifier, not a claim about Google's underlying model. Record the actual visible model label, or `not_exposed` if the service hides it. Never translate a general chat mode label into a video model/version.
- The plan checker reports `browser_preflight_required`: inspect actual controls for duration, aspect ratio, resolution, references and audio. Document those in the brief before freeze and recheck before submission. Unsupported requirements require a user decision; do not silently change format or engine. API asset/model checks do not establish Gemini compatibility. Use `assets add` for references; verify upload rights, hashes and actual UI acceptance separately.
- Compose an immutable request per attempt, with monotonically increasing B numbers per shot. Count all previous requests and failed/unknown attempts, not just imported takes:

```bash
node src/cli.mjs script compose --project projects/<client>/VNNN --shot S001 --take-id B1
```

The resulting `browser-request/1` JSON contains production identity, frozen plan hash and exact prompt. Do not send it to API `plan`/`submit`. For a retry, preserve the earlier request and receipts. Changes to frozen creative intent require a new reviewed plan/version; do not rewrite the frozen plan.

## Browser execution

1. Establish execution authority for this project, service and maximum attempts. A browser subscription is not unlimited authorization. Record the user's authorization, observed credit/quota terms and attempt limit in a separate project browser execution record before Send. No visible price means unknown, not zero; do not buy credits or upgrade a subscription. Existing API budget permission does not authorize browser spending. The API budget command covers API jobs only.
2. Store a pre-submit record beside the request with its SHA-256, profile, prompt, reference asset IDs/hashes, visible settings, model label, time, authorization and cost/quota note. Use a new record filename for each state/event. This prevents a lost tab from causing duplicate generation.
3. Open or reuse the matching Gemini page, upload only authorized references, enter the composed prompt, set the verified controls, and compare the visible input with the request. For a request to type only, stop before Send.
4. Disable native audio if the UI exposes a switch. Otherwise record that it cannot be disabled; exclude the entire native track in assembly. Speech remains a separate audio workflow. Request no baked captions, text or logos; platform watermarks are preserved and evaluated at QA, never promised absent.
5. Send once, then record the conversation/result URL and any visible task identifier. After a timeout or uncertain click, inspect the same conversation/history before any retry. Record `submission_unknown` until reconciled. A missing progress indicator does not authorize sending again.
6. Wait for the visible result, keeping the user informed. When polling in the browser, check both `document.querySelectorAll('video')` / `button[aria-label="Download video"]` and `document.body.innerText` for immediate error banners (`"I seem to be encountering an error"`, `"Can I try something else for you?"`) or quota blocks (`"limit resets at"`, disabled `.input-area-fieldset`) so failures are caught within seconds rather than waiting for a long timeout. Record refusals and failures without deleting attempts. Stop at the approved attempt/quota boundary.
7. Download through the result's download control (`button[aria-label="Download video"]`) with a single click. Never click the download button multiple times in a loop (which triggers Chrome's multiple-download blocker). When available, wrap `window.default_BardChatUi.tO.download` before clicking to capture the exact target filename, and wait until the browser finishes writing the file in Downloads; do not blindly select an unrelated newest file. Preserve the original and any provider watermark. Do not fetch a preview or screen recording as a substitute for an available original.
8. **Single persistent DevTools connection:** When automating Chrome via Remote Debugging (`DevToolsActivePort` / `127.0.0.1:9222`), either use the already-connected `mcp_chrome-devtools_*` tools or keep **one single persistent process** that calls `puppeteer.connect()` once for the entire batch of shots. Never run separate short scripts that repeatedly call `puppeteer.connect()` and `browser.disconnect()`, because each new WebSocket connection triggers Chrome's native `"Allow remote debugging for this browser instance"` confirmation modal for the user.
9. **Reference attachment for continuity prompts:** If a shot's composed prompt includes reference-identity wording (`"Preserve the reference identities... Reference images identify characters only"`), attach the relevant approved character reference image in the Gemini UI even if `mode` is `text_to_video`, or Gemini's chat router may ask to upload an image instead of invoking video generation.

## Import and handoff

Create a completion receipt with these fields (all required, except additional evidence fields):

```json
{
  "status": "completed",
  "request_sha256": "<sha256 of the composed request file>",
  "profile": "<browser profile / account>",
  "model_label": "<visible video model label, or not_exposed>",
  "result_url": "https://gemini.google.com/app/<conversation>",
  "submitted_at": "<ISO timestamp>",
  "completed_at": "<ISO timestamp>",
  "cost_note": "<observed credit/quota use; unknown when not shown>",
  "authorization_note": "<user decision and attempt limit; link local execution record>",
  "settings_note": "<observed ratio, duration, resolution, references and audio controls>"
}
```

Keep cookies, tokens and signed download URLs out of records. Preserve optional evidence such as task ID, selected settings, uploaded reference hashes, screenshots and known credit deductions.

```bash
node src/cli.mjs browser-import --project projects/<client>/VNNN \
  --request projects/<client>/VNNN/requests/S001-B1.json \
  --receipt projects/<client>/VNNN/requests/S001-B1-completed.json \
  --file '/absolute/path/to/downloaded.mp4'
```

The importer checks production/plan/request binding and a video stream, then exclusively creates `<jobs_root>/browser/S001/B1/` with `original.mp4`, request, receipt and manifest. It copies, never moves, the original. Existing and partial versions are preserved; advance the B number after a failed import. Import is local and does not itself approve generation, verify reported billing, decode the entire clip, or accept the take. API job polling/retry commands do not apply to browser records.

Use `$review-generated-video` on the imported original: full visual/technical review, compare measured format/duration with plan, record usable interval and deviations. Store machine-readable review with `source_sha256`. Use that original and review path in the edit manifest, with clip `audio: "silent"`. Run `$assemble-short-video` with `assemble --require-review`, or import accepted clips through `$edit-with-openchatcut`. Native audio remains archived but excluded. Report success only after import and QA; a downloaded take is not a finished master.
