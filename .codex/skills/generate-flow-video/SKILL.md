---
name: generate-flow-video
description: "Generate video takes through the Google Flow website (for example the Omni 1.2 model) in the selected browser profile, download originals into a production project, and hand them to review and assembly. Use when the user chooses Flow browser generation instead of the video API or Gemini."
---

# Generate Flow Video

Third production route: Google Flow's visible UI at `https://flow.google.com/`, driven through the available browser/computer tool. It is not an EVOLINK adapter and not the Gemini route. Never use hidden endpoints, extracted cookies, tokens or signed URLs to automate the site.

Everything that `$generate-browser-video` says about authority, pre-submit records, single submission, `submission_unknown`, watermarks, separate audio and the single persistent DevTools connection applies here unchanged. This skill only adds what differs for Flow.

## Route and plan

- Set `route.model: "flow-browser"` with `text_to_video` or `image_to_video` for each Flow shot **before freeze** (or `target.model_default: "flow-browser"`). It is a local route id, not a Google model id.
- The model is chosen inside Flow. Record the exact visible label in the brief and the receipt, for example `Omni 1.2`. If the selector shows another label or none, record what is shown or `not_exposed`; never infer a version from marketing text, and never silently switch to another Flow model. A model the user named but the UI does not offer is a user decision.
- `browser_preflight_required` is expected. Before freeze, open the target Flow project and document in the brief: visible model label, generation modes (text, frames/start image, ingredients/references), duration choices, aspect ratios, output/download resolution, number of outputs per prompt, audio switch, and the credit cost shown for one generation. Unsupported ratio, duration or reference needs are a user decision, not a silent change.
- Compose attempts as usual: `node src/cli.mjs script compose --project projects/<client>/VNNN --shot S001 --take-id B1`. The request is `browser-request/1` with `provider: "flow-browser"`; the API validator rejects it by design.

## Observed UI (2026-11-17, ULTRA account)

Starting point for the preflight, not a substitute for it. The CLI warns with `browser_ui_mismatch` when a shot falls outside these values.

- Settings chip next to Send, e.g. `Video · 720p · 10s · x2`, opens the panel: `Image | Video`, `Frames | Ingredients`, `16:9 | 9:16`, model dropdown, `360p | 720p`, `Length` slider, outputs `x1–x4`, and the line `Generating will use N credits`.
- Models in the dropdown: `Omni 1.2 Flash` (default), `Omni 1.1 Flash`, `Veo 3.1 - Lite`, `Veo 3.1 - Fast`, `Veo 3.1 - Quality`, `Veo 3.1 - Lite [Lower Priority]`; Omni 1.1 and Veo 3.1 Fast/Quality were marked `Leaving Dec 5`. "Omni 1.2" means `Omni 1.2 Flash` unless the user says otherwise.
- `Frames` mode shows `Start` and `End` slots (maps to `image_to_video`). `Ingredients` mode takes reference media through `+` / drop (identity references for `text_to_video`).
- Length is 3–15 s in 1 s steps. The DOM slider is an index 0–12, not seconds: read the visible `N Sec` label.
- Omni 1.2 Flash credits per output: 720p — 3 credits/s up to 10 s (10 s = 30), then 6 credits/s (15 s = 60); 360p 10 s = 10. Multiply by outputs. Recheck the line before Send.
- No audio switch in the panel: record that native audio cannot be disabled and exclude it in assembly.
- Generation tops out at 720p in this panel; plan `resolution_default: "720p"`. Download-size/upscale options were not checked yet (no clip existed): inspect them on the first result and record the choice.

## Flow specifics

1. **Access.** Verify the profile and signed-in account in the UI. A redirect to `flow.google.com/unsupported-country`, a sign-in wall or a terms/consent dialog stops the route: report it and ask. Do not accept terms, change account settings, use proxies/VPNs or another account on your own.
2. **Project.** Work inside the Flow project the user named (`https://flow.google.com/project/<id>`); record that URL as the base of `result_url`. Do not create, rename or delete Flow projects without a request.
3. **Credits.** Flow charges visible AI credits per generation and per output count. Record the balance before and after and the per-generation cost shown. Set outputs-per-prompt to the number the execution record authorises (default 1). No visible price means `unknown`, not free. Never buy credits or upgrade.
4. **Settings.** Before Send, compare the visible model, mode, ratio, duration and outputs with the request and brief; screenshot the settings panel as evidence. Turn audio off if Flow exposes it; otherwise record that it cannot be disabled and exclude the native track.
5. **References.** Upload only approved assets from the request (`references[].path`, hashes verified). Record which Flow slot received each one (start frame, ingredient, etc.).
6. **Send once.** After an uncertain click or a reload, inspect the project's generation grid/history before any retry. Each extra output of one prompt is a separate candidate: import each under its own B number with the same request only if the request was composed per output; otherwise keep extras archived and note them in the receipt.
7. **Download.** Use Flow's own download control and choose the original/native size, not an upscale, GIF or preview, unless the brief requires otherwise; record the chosen option. Wait until the file has finished writing; do not pick an unrelated newest file in Downloads. Preserve watermarks (including invisible SynthID) and the original file.

## Import and handoff

The receipt uses the same required fields as `$generate-browser-video`, with `result_url` on `flow.google.com` (the project or clip page, never a signed download link) and `model_label` set to the visible label, e.g. `Omni 1.2`. Put credit before/after into `cost_note`, and model/mode/ratio/duration/outputs/download size into `settings_note`.

```bash
node src/cli.mjs browser-import --project projects/<client>/VNNN \
  --request projects/<client>/VNNN/requests/S001-B1.json \
  --receipt projects/<client>/VNNN/requests/S001-B1-completed.json \
  --file '/absolute/path/to/downloaded.mp4'
```

The importer verifies that the request route matches the frozen shot (`flow-browser`) and that `result_url` is a Flow page, then creates `<jobs_root>/browser/S001/B1/` with the copied original. Then `$review-generated-video`, and `$assemble-short-video` or `$edit-with-openchatcut`, exactly as for other takes. A downloaded clip is not an accepted take, and an imported take is not a master.
