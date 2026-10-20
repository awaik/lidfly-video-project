# Research notes and source trail

Research snapshot: 2026-08-14. Re-check current provider documentation before submitting any job.

## First-party model sources

- [Kuaishou: Kling AI 3.0 launch](https://ir.kuaishou.com/news-releases/news-release-details/kling-ai-launches-30-model-ushering-era-where-everyone-can-be) names Video 3.0 and Video 3.0 Omni, describes up to 15-second generation, native multilingual audio, multimodal inputs, reference generation/editing, and multi-shot controls. It does not establish every third-party API name or limit.
- [ByteDance Seed: Seedance 2.0 launch](https://seed.bytedance.com/blog/seedance-2-0-official-launch) describes native multimodal video creation with image, video, audio, and text inputs.
- [BytePlus ModelArk: Seedance 2.0 video-generation API](https://docs.byteplus.com/en/docs/modelark/1520757) is the implementation source for the BytePlus adapter. Its schema and limits take precedence over older examples.
- [EVOLINK: Seedance 2.5 complete parameter guide](https://evolink.ai/docs/en/api-manual/video-series/seedance2.5/seedance-2.5-overview) documents the live gateway routes, five exact model IDs, 4–30 second/auto duration contract, 480p/720p output, multimodal limits, audio, edit, extend, and async task behavior used by this repository.

## YouTube workflow sources reviewed

These videos informed workflow heuristics only. Their UI limits, rankings, prices, and provider labels are not treated as API facts.

- [Ben Kaluza: How to Turn Storyboards into Consistent Videos using Seedance 2.0](https://www.youtube.com/watch?v=DosWo7GplD4): storyboard-first planning, compact character/location sheets, draft quality before finals, continuity via selected frames.
- [Dan Kieft: STOP Wasting Credits & Master Kling 3.0](https://www.youtube.com/watch?v=b_RghITuQQM): mode selection, image/start-end control, concise prompt structure, multi-shot and lip-sync review.
- [Dan Kieft: Master Seedance 2.0](https://www.youtube.com/watch?v=lkL8mlpVScY): global context plus timestamped beats, lower-resolution tests, reference discipline, and action/audio QA.
- [Yaroflasher: Seedance 2.0 + Grok + Kling 3.0 pipeline](https://www.youtube.com/watch?v=_W81Oxu76Ug): generate alternatives, select engines per scene, use Kling for controlled bridges, use Seedance for demanding motion, finish sound/edit in post.
- [Tao Prompts: Google Omni vs Seedance 2.0 vs Kling 3.0](https://www.youtube.com/watch?v=elCv87a4iK4): comparative stress tests for motion, storyboards, dialogue, and detail. Results are anecdotal and shot-dependent.
- [Kling AI: Cinematic AI Films with Kling 3.0 & 3.0 Omni](https://www.youtube.com/watch?v=WmC1nqz10Qk): first-party overview of the Video 3.0 family in a filmmaking workflow.

## Common findings retained

- Storyboards expose weak shot variety and continuity errors before paid generation.
- Character references alone are insufficient when locations and object states must remain coherent.
- One clear role per reference is more reliable than uploading every available asset.
- Draft resolution and multiple candidates reduce the cost of discovering prompt or continuity failures.
- Shorter, simpler clips are safer for dialogue, anatomy, and editability.
- Screenshotting an accepted frame or returning a last frame can support consecutive-shot continuity.
- Final titles, exact logos, captions, timing, color, VO, and sound design belong in post.

## Claims deliberately excluded

- guaranteed completion or retention percentages;
- universal credit prices;
- universal reference counts or resolution limits across providers;
- categorical claims that one model always beats another;
- unsupported `Kling O3` API identifiers;
- exact text rendering without frame-by-frame QA.

## YouTube delivery sources

- [YouTube recommended upload encoding settings](https://support.google.com/youtube/answer/1722171?hl=en)
- [YouTube disclosure rules for realistic generated or altered content](https://support.google.com/youtube/answer/14328491?hl=en)
- [YouTube three-minute Shorts information](https://support.google.com/youtube/answer/15424877?hl=en)

Use these sources as current platform guidance, but check them again before publishing because platform rules can change.
