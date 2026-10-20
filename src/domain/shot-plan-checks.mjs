import { buildEvolinkPayload, estimateJobCost } from "../providers/evolink/model-catalog.mjs";
import { parseAspectRatio } from "./aspect-ratio.mjs";
import { protagonistOf } from "./continuity.mjs";
import { aspectRatioForShot, CLOSE_SHOT_SIZES, maxEventsForDuration } from "./shot-plan.mjs";
import { composeShotPrompt } from "./shot-prompt.mjs";
import {
  aspectRatioChoicesFor,
  normalizeVideoRequest,
  resolutionChoicesFor,
} from "./video-request.mjs";

const COMPOUND_MARKERS = [" and ", " while ", " then ", " и ", " затем ", " после чего "];
const TIMELINE_IN_PROSE = /\d+\s*-\s*\d+\s*s\s*:|\bзатем\b|\bпотом\b/i;
const REFERENCE_MODES = new Set(["reference_to_video", "image_to_video", "video_edit", "video_extend"]);

function finding(level, code, message, extra = {}) {
  return { level, code, shot_id: null, beat_id: null, ...extra, message };
}

/** Anchors of one kind carried by a shot, so "which light is this" is answerable. */
function anchorsOfKind(continuity, shot, kind) {
  return shot.continuity_keys.filter((key) => continuity.anchors[key]?.kind === kind).sort();
}

function checkStructure(plan, continuity, assets, findings) {
  const beatIds = new Set(plan.beats.map((beat) => beat.beat_id));
  const assetIds = new Set((assets ?? []).map((asset) => asset.asset_id));
  const usedAnchors = new Set();

  for (const shot of plan.shots) {
    for (const beatId of shot.beat_ids) {
      if (!beatIds.has(beatId)) {
        findings.push(
          finding("blocker", "unknown_beat_reference", `${shot.shot_id} ссылается на бит ${beatId}, которого нет в плане`, {
            shot_id: shot.shot_id,
          }),
        );
      }
    }
    for (const key of shot.continuity_keys) {
      if (!continuity.anchors[key]) {
        findings.push(
          finding("blocker", "unknown_anchor", `${shot.shot_id}: якорь ${key} не объявлен в continuity.json`, {
            shot_id: shot.shot_id,
          }),
        );
        continue;
      }
      usedAnchors.add(key);
    }
    for (const id of shot.subject) {
      if (!continuity.entities[id]) {
        findings.push(
          finding("blocker", "unknown_entity", `${shot.shot_id}: сущность ${id} не объявлена в continuity.json`, {
            shot_id: shot.shot_id,
          }),
        );
      }
    }
    if (assets) {
      for (const id of shot.identity_refs) {
        if (!assetIds.has(id)) {
          findings.push(
            finding(
              "blocker",
              "unknown_identity_asset",
              `${shot.shot_id}: референса ${id} нет в реестре проекта; добавьте его через assets add --asset-id ${id}`,
              { shot_id: shot.shot_id },
            ),
          );
        }
      }
    }
  }

  for (const key of Object.keys(continuity.anchors)) {
    if (!usedAnchors.has(key)) {
      findings.push(
        finding("warning", "anchor_never_used", `Якорь ${key} объявлен, но ни один шот его не несёт — обычно это опечатка в continuity_keys`),
      );
    }
  }
}

function checkCoverage(plan, findings) {
  const coverage = new Map(plan.beats.map((beat) => [beat.beat_id, []]));
  for (const shot of plan.shots) {
    if (shot.beat_ids.length === 0) {
      findings.push(
        finding(
          "blocker",
          "shot_without_beat",
          `${shot.shot_id} не обслуживает ни одного бита сценария: оплаченная секунда без сценарной функции`,
          { shot_id: shot.shot_id },
        ),
      );
      continue;
    }
    for (const beatId of shot.beat_ids) coverage.get(beatId)?.push(shot.shot_id);
  }

  for (const beat of plan.beats) {
    const shots = coverage.get(beat.beat_id) ?? [];
    if (shots.length === 0) {
      const optional = beat.importance === "optional";
      findings.push(
        finding(
          optional ? "warning" : "blocker",
          "beat_not_covered",
          `Бит ${beat.beat_id} «${beat.label}» не покрыт ни одним шотом. Дайте ему шот или понизьте importance до optional и объясните почему`,
          { beat_id: beat.beat_id },
        ),
      );
      continue;
    }
    if (shots.length > 2) {
      findings.push(
        finding(
          "warning",
          "beat_split_across_shots",
          `Бит ${beat.beat_id} размазан по ${shots.length} шотам (${shots.join(", ")}) — риск, что он не прочитается ни в одном`,
          { beat_id: beat.beat_id },
        ),
      );
    }
  }
}

function checkDensity(plan, findings) {
  const climaxBeats = new Set(
    plan.beats.filter((beat) => beat.kind === "climax" || beat.importance === "climax").map((beat) => beat.beat_id),
  );

  for (const shot of plan.shots) {
    const limit = maxEventsForDuration(shot.duration_seconds);
    if (shot.events.length > limit) {
      findings.push(
        finding(
          "blocker",
          "shot_event_overload",
          `${shot.shot_id}: ${shot.events.length} событий на ${shot.duration_seconds} с, модель отыграет не больше ${limit}. Разбейте шот или удлините его`,
          { shot_id: shot.shot_id },
        ),
      );
    }
    if (shot.source === "generated" && shot.events.length === 0) {
      findings.push(
        finding("blocker", "shot_without_event", `${shot.shot_id}: не описано ни одного события — модели нечего отыгрывать`, {
          shot_id: shot.shot_id,
        }),
      );
    }

    const carriesClimax = shot.beat_ids.some((beatId) => climaxBeats.has(beatId));
    if (carriesClimax && (shot.events.length > 1 || shot.beat_ids.length > 1)) {
      findings.push(
        finding(
          "blocker",
          "climax_not_isolated",
          `${shot.shot_id} несёт кульминацию и при этом ${shot.events.length} событий и ${shot.beat_ids.length} бита. Кульминации нужен отдельный шот, иначе её просто не окажется в кадре`,
          { shot_id: shot.shot_id },
        ),
      );
    }

    const windows = shot.events.filter((event) => event.window_seconds).map((event) => event.window_seconds);
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index][0] < windows[index - 1][1]) {
        findings.push(
          finding("blocker", "event_window_invalid", `${shot.shot_id}: окна событий пересекаются или идут не по порядку`, {
            shot_id: shot.shot_id,
          }),
        );
        break;
      }
    }
    for (const event of shot.events) {
      if (event.window_seconds && event.window_seconds[1] - event.window_seconds[0] < 1.5) {
        findings.push(
          finding(
            "warning",
            "event_window_short",
            `${shot.shot_id}/${event.event_id}: меньше 1.5 с на событие — оно скорее всего не прочитается`,
            { shot_id: shot.shot_id },
          ),
        );
      }
      const lowered = ` ${event.text.toLowerCase()} `;
      if (COMPOUND_MARKERS.some((marker) => lowered.includes(marker))) {
        findings.push(
          finding(
            "warning",
            "event_text_compound",
            `${shot.shot_id}/${event.event_id}: в тексте события склеены два действия — разнесите их по отдельным событиям`,
            { shot_id: shot.shot_id },
          ),
        );
      }
    }

    if (shot.style_note && TIMELINE_IN_PROSE.test(shot.style_note)) {
      findings.push(
        finding(
          "blocker",
          "style_note_contains_timeline",
          `${shot.shot_id}: style_note содержит таймлайн или перечисление действий — это обход счётчика событий, перенесите их в events`,
          { shot_id: shot.shot_id },
        ),
      );
    }
  }
}

function checkContinuity(plan, continuity, findings) {
  const generated = plan.shots.filter((shot) => shot.source === "generated");

  for (const shot of generated) {
    for (const kind of continuity.required_anchor_kinds) {
      if (anchorsOfKind(continuity, shot, kind).length === 0) {
        findings.push(
          finding(
            "blocker",
            "missing_required_anchor_kind",
            `${shot.shot_id} не несёт якоря вида ${kind}: без него модель выбирает ${kind} заново в каждом шоте`,
            { shot_id: shot.shot_id },
          ),
        );
      }
    }
    for (const id of shot.subject) {
      const entity = continuity.entities[id];
      if (entity?.scale_anchor && !shot.continuity_keys.includes(entity.scale_anchor)) {
        findings.push(
          finding(
            "blocker",
            "scale_anchor_missing",
            `${shot.shot_id}: ${id} в кадре, но якорь масштаба ${entity.scale_anchor} не указан — размер уплывёт`,
            { shot_id: shot.shot_id },
          ),
        );
      }
    }
    if (shot.location_change && !shot.edit_purpose) {
      findings.push(
        finding("warning", "location_change_unexplained", `${shot.shot_id}: смена локации объявлена, но не объяснена в edit_purpose`, {
          shot_id: shot.shot_id,
        }),
      );
    }
  }

  for (let index = 1; index < generated.length; index += 1) {
    const previous = generated[index - 1];
    const current = generated[index];
    const previousLocations = anchorsOfKind(continuity, previous, "location");
    const currentLocations = anchorsOfKind(continuity, current, "location");
    if (previousLocations.length && currentLocations.length) {
      const shared = currentLocations.some((key) => previousLocations.includes(key));
      if (!shared && !current.location_change && !previous.location_change) {
        findings.push(
          finding(
            "blocker",
            "neighbor_location_anchor_mismatch",
            `${previous.shot_id} и ${current.shot_id} стоят подряд в разных локациях (${previousLocations.join(", ")} → ${currentLocations.join(", ")}) без объявленного location_change: true — так и получаются три разных моста`,
            { shot_id: current.shot_id },
          ),
        );
      }
    }
  }

  // A→B→A on light is exactly the evening→day→evening flicker that showed up in
  // the finished trailer; a deliberate one is declared with time_jump.
  const lightSequence = generated
    .map((shot) => ({ shot, light: anchorsOfKind(continuity, shot, "light").join("+") }))
    .filter((entry) => entry.light);
  for (let index = 2; index < lightSequence.length; index += 1) {
    const [a, b, c] = [lightSequence[index - 2], lightSequence[index - 1], lightSequence[index]];
    if (a.light === c.light && a.light !== b.light && !b.shot.time_jump && !c.shot.time_jump) {
      findings.push(
        finding(
          "blocker",
          "light_anchor_flapping",
          `Свет скачет ${a.shot.shot_id} → ${b.shot.shot_id} → ${c.shot.shot_id} и возвращается назад. Либо выровняйте якорь света, либо объявите time_jump: true`,
          { shot_id: c.shot.shot_id },
        ),
      );
    }
  }
}

function checkIdentity(plan, continuity, findings) {
  for (const shot of plan.shots) {
    if (shot.source !== "generated") continue;
    const acceptsReferences = REFERENCE_MODES.has(shot.route.mode);
    if (!acceptsReferences && shot.identity_refs.length) {
      findings.push(
        finding(
          "blocker",
          "identity_reference_in_unsupported_mode",
          `${shot.shot_id}: режим ${shot.route.mode} не принимает референсы, они будут молча выброшены`,
          { shot_id: shot.shot_id },
        ),
      );
      continue;
    }
    for (const id of shot.subject) {
      const entity = continuity.entities[id];
      if (!entity) continue;
      if (entity.identity_assets.length === 0) {
        findings.push(
          finding(
            "warning",
            "first_appearance_no_reference",
            `${shot.shot_id}: у ${id} нет ни одного identity-референса; примите первый дубль и заведите его как эталон, иначе внешность поплывёт`,
            { shot_id: shot.shot_id },
          ),
        );
        continue;
      }
      if (!acceptsReferences) continue;
      const covered = entity.identity_assets.some((asset) => shot.identity_refs.includes(asset));
      if (!covered) {
        findings.push(
          finding(
            "blocker",
            "identity_without_reference",
            `${shot.shot_id}: ${id} в кадре, но ни один его референс (${entity.identity_assets.join(", ")}) не подан`,
            { shot_id: shot.shot_id },
          ),
        );
      }
    }
  }
}

function checkReadability(plan, continuity, findings) {
  const protagonist = protagonistOf(continuity);
  if (protagonist?.requires_close_up) {
    const hasClose = plan.shots.some(
      (shot) => CLOSE_SHOT_SIZES.includes(shot.shot_size) && shot.subject.includes(protagonist.id),
    );
    if (!hasClose) {
      const feature = protagonist.signature_feature
        ? ` — примета «${protagonist.signature_feature}» нигде не прочитается`
        : "";
      findings.push(
        finding(
          "blocker",
          "protagonist_never_close",
          `В плане нет ни одного крупного плана ${protagonist.id}${feature}. Переведите шот наименьшей информационной ценности в close_up`,
        ),
      );
    }
  }

  const sizes = new Set(plan.shots.map((shot) => shot.shot_size));
  if (plan.shots.length >= 3 && sizes.size === 1) {
    findings.push(
      finding("warning", "shot_size_monotony", `Все шоты одной крупности (${[...sizes][0]}) — монтаж будет плоским`),
    );
  }
}

function checkDurationAndRoute(plan, continuity, findings) {
  const total = plan.shots.reduce((sum, shot) => sum + shot.timeline_seconds, 0);
  const rounded = Math.round(total * 1e3) / 1e3;
  const { duration_seconds_total: target, duration_tolerance_seconds: tolerance } = plan.target;
  if (Math.abs(rounded - target) > tolerance) {
    findings.push(
      finding(
        "blocker",
        "duration_total_mismatch",
        `Сумма таймлайна ${rounded} с не сходится с целевой ${target} с (допуск ±${tolerance})`,
      ),
    );
  }

  for (const shot of plan.shots) {
    if (shot.source !== "generated") continue;
    const ratio = shot.timeline_seconds / shot.duration_seconds;
    if (ratio < 0.5 || ratio > 2) {
      findings.push(
        finding(
          "warning",
          "retime_ratio_extreme",
          `${shot.shot_id}: ${shot.duration_seconds} с генерации против ${shot.timeline_seconds} с таймлайна — ретайминг ×${ratio.toFixed(2)} будет заметен`,
          { shot_id: shot.shot_id },
        ),
      );
    }

    if (shot.route.model === "gemini-browser") {
      findings.push(finding("warning", "browser_preflight_required",
        `${shot.shot_id}: verify model label, references, duration, ratio, resolution and credit allowance in Gemini UI before submission; API pricing does not apply`,
        { shot_id: shot.shot_id }));
      continue;
    }

    // Dry-run the exact builder the paid call uses. It knows every provider
    // limit, so this one check cannot drift away from what the API accepts.
    const { prompt } = composeShotPrompt({ plan, continuity, shot });
    const draft = {
      schema_version: 1,
      shot_id: shot.shot_id,
      take_id: "T000",
      provider: "evolink",
      model: shot.route.model,
      mode: shot.route.mode,
      prompt,
      duration_seconds: shot.duration_seconds,
      aspect_ratio: aspectRatioForShot(plan.target, shot.route),
      resolution: plan.target.resolution_default,
      references: shot.identity_refs.map((assetId) => ({
        asset_id: assetId,
        role: "identity",
        url: "https://files.evolink.ai/preflight/placeholder.png",
        rights_status: "approved",
      })),
      options: {},
    };
    try {
      const request = normalizeVideoRequest(draft);
      buildEvolinkPayload(request, {
        referenceUrls: Object.fromEntries(
          request.references.map((reference) => [reference.asset_id, reference.url]),
        ),
      });
      const estimate = estimateJobCost(request);
      if (estimate.status !== "estimated") {
        findings.push(
          finding(
            "warning",
            "cost_unknown_rate",
            `${shot.shot_id}: у маршрута ${shot.route.model}/${plan.target.resolution_default} нет измеренной цены, оценка будет неизвестной`,
            { shot_id: shot.shot_id },
          ),
        );
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      // checkAspectRatio reads the same table this builder does and names the
      // route that refused, so repeating the builder's terser verdict here
      // would report one problem twice.
      if (/aspect_ratio must be/.test(message)) continue;
      const code = /duration_seconds must be/.test(message)
        ? "duration_below_provider_minimum"
        : "route_unbuildable";
      findings.push(finding("blocker", code, `${shot.shot_id}: ${message}`, { shot_id: shot.shot_id }));
    }
  }
}

/**
 * The routes a plan will actually take.
 *
 * A plan made entirely of graphics and stock still declares a delivery shape,
 * and freezing an impossible one only to have the first generated shot reject
 * it is the failure these checks exist to prevent — so fall back to the target
 * default rather than skipping the plan entirely.
 */
function deliveryRoutes(plan) {
  const generated = plan.shots.filter((shot) => shot.source === "generated");
  if (generated.length) {
    return generated.map((shot) => ({ shot_id: shot.shot_id, route: shot.route }));
  }
  return [{ shot_id: null, route: { model: plan.target.model_default, mode: "text_to_video" } }];
}

function checkAspectRatio(plan, findings) {
  for (const { shot_id: shotId, route } of deliveryRoutes(plan)) {
    if (route.model === "gemini-browser") continue;
    const { choices } = aspectRatioChoicesFor(route.model, route.mode);
    const requested = aspectRatioForShot(plan.target, route);
    const label = shotId ?? "target";
    if (!choices.includes(requested)) {
      findings.push(
        finding(
          "blocker",
          "aspect_ratio_unsupported_by_route",
          `${label}: ${route.model}/${route.mode} принимает только ${choices.join(", ")}, а target.aspect_ratio=${plan.target.aspect_ratio}; смените соотношение или маршрут`,
          { shot_id: shotId },
        ),
      );
      continue;
    }
    // Adaptive routes copy the shape of the start frame or the source video.
    // That is not a defect, but it moves the decision out of the plan and into
    // the reference, and nothing downstream will catch a portrait start frame
    // in a landscape project.
    if (requested === "adaptive" && plan.target.aspect_ratio !== "adaptive") {
      findings.push(
        finding(
          "warning",
          "aspect_ratio_from_source",
          `${label}: ${route.model}/${route.mode} берёт ориентацию из исходника, а не из target.aspect_ratio=${plan.target.aspect_ratio} — стартовый кадр должен быть ${plan.target.aspect_ratio}`,
          { shot_id: shotId },
        ),
      );
    }
  }
}

/** Short side in pixels, so a resolution tier can be stated as real dimensions. */
const SHORT_SIDE_BY_RESOLUTION = Object.freeze({ "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 });

function impliedDimensions(aspectRatio, resolution) {
  const shortSide = SHORT_SIDE_BY_RESOLUTION[resolution];
  const ratio = parseAspectRatio(aspectRatio);
  if (!shortSide || ratio === null) return null;
  return ratio >= 1
    ? `${Math.round(shortSide * ratio)}×${shortSide}`
    : `${shortSide}×${Math.round(shortSide / ratio)}`;
}

/**
 * Say out loud when the chosen model cannot go any higher.
 *
 * Seedance 2.5 stops at 720p, so a master off that route is at most 1280 on the
 * long side no matter which orientation the plan targets. Learning that after
 * the takes are paid for is the expensive version of this warning.
 */
function checkResolutionCeiling(plan, findings) {
  const resolution = plan.target.resolution_default;
  const models = [...new Set(deliveryRoutes(plan).map(({ route }) => route.model))].sort();
  for (const model of models) {
    if (model === "gemini-browser") continue;
    const choices = resolutionChoicesFor(model);
    const ceiling = choices[choices.length - 1];
    if (ceiling !== resolution) continue;
    if ((SHORT_SIDE_BY_RESOLUTION[ceiling] ?? 0) >= 1080) continue;
    const dimensions = impliedDimensions(plan.target.aspect_ratio, resolution);
    findings.push(
      finding(
        "warning",
        "resolution_ceiling",
        `${model} не поднимается выше ${ceiling}${dimensions ? `, мастер будет максимум ${dimensions}` : ""}. Выше — seedance-2.0 (variant standard) или kling-*, но у kling нет измеренной цены и оценка вернётся как unknown_rate`,
      ),
    );
  }
}

function checkSpeech(plan, findings) {
  for (const shot of plan.shots) {
    if (!shot.dialogue) continue;
    if (plan.target.audio_mode && /no[_ ]speech|titles_only/i.test(plan.target.audio_mode)) {
      findings.push(
        finding("blocker", "dialogue_without_audio", `${shot.shot_id}: реплика задана, но режим звука проекта её не воспроизводит`, {
          shot_id: shot.shot_id,
        }),
      );
    }
    const words = shot.dialogue.trim().split(/\s+/).length;
    if (words / shot.duration_seconds > 2.2) {
      findings.push(
        finding("warning", "dialogue_too_dense", `${shot.shot_id}: ${words} слов на ${shot.duration_seconds} с — артикуляция не успеет`, {
          shot_id: shot.shot_id,
        }),
      );
    }
  }
}

/**
 * Every machine-checkable way a shot plan is known to fail.
 *
 * Pure by design: it takes documents, not paths, so each rule is testable
 * without a workspace and cannot quietly depend on the filesystem.
 */
export function shotPlanFindings({ plan, continuity, assets = null, projectId = null }) {
  const findings = [];

  if (projectId && plan.project_id !== projectId) {
    findings.push(
      finding("blocker", "plan_project_mismatch", `План принадлежит ${plan.project_id}, а лежит в проекте ${projectId}`),
    );
  }
  if (continuity.project_id !== plan.project_id) {
    findings.push(
      finding("blocker", "continuity_project_mismatch", `continuity.json принадлежит ${continuity.project_id}, а план — ${plan.project_id}`),
    );
  }
  if (plan.shots.length === 0) {
    findings.push(finding("blocker", "plan_has_no_shots", "В плане нет ни одного шота"));
  }
  if (plan.beats.length === 0) {
    findings.push(
      finding("blocker", "plan_has_no_beats", "В плане нет ни одного бита сценария: покрытие проверить невозможно"),
    );
  }

  checkStructure(plan, continuity, assets, findings);
  checkCoverage(plan, findings);
  checkDensity(plan, findings);
  checkContinuity(plan, continuity, findings);
  checkIdentity(plan, continuity, findings);
  checkReadability(plan, continuity, findings);
  checkDurationAndRoute(plan, continuity, findings);
  checkAspectRatio(plan, findings);
  checkResolutionCeiling(plan, findings);
  checkSpeech(plan, findings);

  const blockers = findings.filter((item) => item.level === "blocker").length;
  return {
    ok: blockers === 0,
    blockers,
    warnings: findings.length - blockers,
    findings,
  };
}
