/**
 * Browser generation routes. A route id is a local planning identifier, never an
 * API model id: the website decides which model actually runs, and the receipt
 * records the visible label. Capabilities are verified in the UI, not here.
 */
export const BROWSER_ROUTES = Object.freeze({
  "gemini-browser": Object.freeze({
    service: "Google Gemini",
    entry_url: "https://gemini.google.com/videos",
    result_hosts: Object.freeze(["gemini.google.com"]),
    modes: Object.freeze(["text_to_video", "image_to_video"]),
    skill: "generate-browser-video",
  }),
  "flow-browser": Object.freeze({
    service: "Google Flow",
    entry_url: "https://flow.google.com/",
    result_hosts: Object.freeze(["flow.google.com"]),
    modes: Object.freeze(["text_to_video", "image_to_video"]),
    skill: "generate-flow-video",
    // Seen in the Flow settings panel for Omni 1.2 Flash on 2026-11-17. Websites change
    // without notice: a mismatch is a warning to recheck, the preflight is the authority.
    observed_ui: Object.freeze({
      observed_at: "2026-11-17",
      model_label: "Omni 1.2 Flash",
      aspect_ratios: Object.freeze(["16:9", "9:16"]),
      resolutions: Object.freeze(["360p", "720p"]),
      duration_seconds: Object.freeze({ min: 3, max: 15, step: 1 }),
    }),
  }),
});

/** Differences between a planned shot and the UI last observed for its route. */
export function browserUiMismatches(routeId, { aspect_ratio: aspectRatio, resolution, duration_seconds: duration }) {
  const ui = BROWSER_ROUTES[routeId]?.observed_ui;
  if (!ui) return [];
  const issues = [];
  if (!ui.aspect_ratios.includes(aspectRatio)) issues.push(`ratio ${aspectRatio} not in ${ui.aspect_ratios.join("/")}`);
  if (!ui.resolutions.includes(resolution)) issues.push(`resolution ${resolution} not in ${ui.resolutions.join("/")}`);
  const { min, max, step } = ui.duration_seconds;
  if (!(duration >= min && duration <= max && Number.isInteger((duration - min) / step))) {
    issues.push(`duration ${duration}s not in ${min}–${max}s by ${step}s`);
  }
  return issues;
}

export function isBrowserRoute(model) {
  return Object.hasOwn(BROWSER_ROUTES, model);
}

export function browserRouteModes() {
  return Object.fromEntries(Object.entries(BROWSER_ROUTES).map(([id, route]) => [id, [...route.modes]]));
}

/** Accepts the service page of the route; rejects signed download URLs and foreign hosts. */
export function browserResultUrl(routeId, value) {
  const route = BROWSER_ROUTES[routeId];
  if (!route) throw new Error(`Unknown browser route: ${routeId}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("receipt.result_url must be a URL");
  }
  if (url.protocol !== "https:" || !route.result_hosts.includes(url.hostname) || url.username || url.password) {
    throw new Error(`result_url must be a ${route.service} page (${route.result_hosts.join(", ")}), not a signed download URL`);
  }
  return url.href;
}
