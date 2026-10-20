# Reference intake

Read this before creative planning whenever a shot must preserve a specific person, product, or
location. Every number here comes from `src/providers/evolink/model-catalog.mjs`; verify current
provider documentation before treating any of it as a permanent API guarantee.

## Ask the user first

After production bootstrap and before planning identity-dependent shots, resolve the questions below from existing answers and assets. Ask one block in the user's language only for missing information. Do not infer that the user has no photos because they did not mention any; do not repeat resolved questions.

1. Есть ли готовые фото или видео персонажа, продукта или локации? Где они лежат?
2. Кто на фото и есть ли разрешение на использование лица/голоса?
3. Нужно ли, чтобы человек/продукт выглядел одинаково во всех кадрах, или каждый кадр самостоятелен?
4. Есть ли обязательные элементы: логотип, упаковка, форма одежды, конкретное помещение?

If the user confirms there are no references, record the limitation. If recognizable identity is required, agree on suitable reference creation or a change to that requirement before dependent generation. Use text-to-video when consistent with the agreed brief; do not silently abandon identity continuity.

## What to request

Ask for separate compact sheets, never one collage:

- **Character:** frontal face, three-quarter, profile, full body, wardrobe detail. 3–5 frames.
- **Location:** wide establishing view, reverse angle, one recurring landmark.
- **Product/object:** proportions against a neutral background, label side, material close-up,
  the interaction state that appears in the shot.
- **Storyboard:** one panel per intended edit beat.

Quality rules to pass on to the user:

- one subject per frame — a second person in the background can blend into the generated identity;
- sharp, evenly lit, no heavy filters or beauty retouching;
- consistent wardrobe and hairstyle across the character sheet unless a change is scripted;
- short side of at least 1024px;
- framing that matches the project's `target.aspect_ratio`;
- JPEG or PNG always; WebP only when the shot routes to Seedance.

## Ingest before planning

Copy every accepted reference into the project. The command never moves, rewrites, or deletes the
user's original, and it refuses to overwrite an `asset_id` that already holds different content.

```bash
node src/cli.mjs assets add \
  --project projects/acme/V001 \
  --file /Users/name/Downloads/hero-1.jpg \
  --asset-id hero-front \
  --role identity \
  --rights approved \
  --note "прислано пользователем 2026-08-05"
```

`--rights` accepts `approved` or `not_required` only. Never set `approved` on the user's behalf:
it records that the user confirmed the right to use that likeness, logo, or footage.

The format is detected from the file contents, so a HEIC or video renamed to `.jpg` is rejected at
ingest instead of failing after a paid submission. Ask the user to convert it.

## Assign one role per reference

Give every asset exactly one job. Competing references blend and produce anatomy errors.

| Role | Controls |
| --- | --- |
| `identity` | face and body of a person |
| `wardrobe` | clothing and accessories |
| `environment` | location and set |
| `object` | product or prop |
| `composition` | framing and layout |
| `style` | look, palette, grain |
| `storyboard` | panel to animate |
| `start_frame` / `end_frame` | exact opening/closing image |
| `reference_image` | general conditioning without a narrower role |
| `reference_video` / `source_video` / `reference_audio` | HTTPS URL only — no local upload |

Several `identity` frames of the same person are correct and expected. Two different people under
`identity` are not.

## Mode capacity

| Model / mode | Images | Video | Audio | Elements |
| --- | --- | --- | --- | --- |
| `seedance-2.5` / `text_to_video` | — | — | — | — |
| `seedance-2.5` / `image_to_video` | `start_frame` required, `end_frame` optional | — | — | — |
| `seedance-2.5` / `reference_to_video` | up to 30 | up to 10 | up to 10 | — |
| `seedance-2.5` / `video_edit` | up to 30 | up to 10; first is required source | up to 10 | — |
| `seedance-2.5` / `video_extend` | up to 30 | up to 10; first is required source | up to 10 | — |
| `seedance-2.0` / `text_to_video` | — | — | — | — |
| `seedance-2.0` / `image_to_video` | `start_frame` required, `end_frame` optional | — | — | — |
| `seedance-2.0` / `reference_to_video` | up to 9 | up to 3 | up to 3 | — |
| `kling-o3` / `text_to_video` | — | — | — | up to 7 |
| `kling-o3` / `image_to_video` | up to 7 including elements | — | — | up to 3 |
| `kling-o3` / `reference_to_video` | up to 4 including elements | 1 required | — | up to 4 |
| `kling-o3` / `video_edit` | up to 4 including elements | 1 required (source) | — | up to 4 |
| `kling-v3` / `text_to_video` | — | — | — | — |
| `kling-v3` / `image_to_video` | `start_frame` required, `end_frame` optional | — | — | up to 3 |

File limits: Seedance accepts JPEG/PNG/WebP up to 30MB; both Kling families accept JPEG/PNG up to
10MB. Seedance 2.5 accepts 4–30 second outputs at 480p/720p; Image-to-Video, Video Edit, and Video
Extend use `adaptive` aspect ratio, which copies the shape of the start frame or source video rather than the plan target. A `kling-o3` last frame cannot be combined with additional
reference images.

## Check before spending credits

Run the set against the intended route. The check reuses the same catalog that builds the real
payload, so its verdict cannot drift from what would be submitted.

```bash
node src/cli.mjs assets check \
  --project projects/acme/V001 \
  --model kling-o3 \
  --mode reference_to_video \
  --assets hero-front,hero-profile,studio-wide \
  --video-url https://cdn.example.com/reference.mp4 \
  --video-rights approved
```

For `kling-o3/reference_to_video` and `kling-o3/video_edit`, `--video-url` supplies the required
`reference_video` or `source_video` role to the same request builder used by planning. It must be an
HTTPS URL. The check stays local and does not download the video, so confirm separately that the URL
is public and stable. `--video-rights` is required with the URL; set it to `approved` only after the
user confirms authorization, or to `not_required` only when likeness, logo, and footage rights truly
do not apply.

The report returns `ok`, the mode capacity, and findings at three levels:

- **blocker** — the request would be rejected or the file is unusable: too many images, unsupported
  format, oversized file, missing required role, missing video reference. Exit code is 1.
- **warning** — it will submit but risks the shot: short side under 1024px, framing that does not
  match the output ratio, the same file ingested twice, or `not_required` recorded for an identity.
- **info** — the mode ignores the references entirely.

Resolve every blocker before generation. Report warnings to the user with the trade-off rather than
silently accepting them.

## When the photos do not fit

In order of preference:

1. select a subset that fits the mode — usually the strongest 3–4 identity frames;
2. ask the user for one missing angle instead of padding the set with weak frames;
3. change the mode, not the model: `reference_to_video` is not always the right route for a shot
   whose real need is an exact opening composition;
4. reroute the shot only when the required control does not exist in the current model, and record
   the change per the routing matrix.

Never crop, upscale, retouch, or otherwise alter a user's original to make it pass. Ask instead.
