const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

export function assertNoUnknownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
}

export function requiredString(value, name, { max = Infinity, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.length > max) throw new RangeError(`${name} must be at most ${max} characters`);
  return value.trim();
}

export function optionalString(value, name, options) {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, name, options);
}

export function identifier(value, name) {
  const normalized = requiredString(value, name);
  if (!IDENTIFIER.test(normalized)) {
    throw new TypeError(`${name} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return normalized;
}

export function integerInRange(value, name, min, max, fallback) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return normalized;
}

export function numberInRange(value, name, min, max, fallback) {
  const normalized = value === undefined ? fallback : Number(value);
  if (normalized === undefined) throw new TypeError(`${name} is required`);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    throw new RangeError(`${name} must be a number from ${min} to ${max}`);
  }
  return normalized;
}

export function oneOf(value, name, choices, fallback) {
  const normalized = value === undefined ? fallback : value;
  if (!choices.includes(normalized)) {
    throw new RangeError(`${name} must be one of: ${choices.join(", ")}`);
  }
  return normalized;
}

export function httpUrl(value, name, { httpsOnly = false } = {}) {
  const raw = requiredString(value, name);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a valid URL`);
  }
  const protocols = httpsOnly ? ["https:"] : ["https:", "http:"];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new TypeError(`${name} must be a public ${httpsOnly ? "HTTPS" : "HTTP(S)"} URL without embedded credentials`);
  }
  if (
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1$)/i.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)
  ) {
    throw new TypeError(`${name} must not target a private host`);
  }
  return url.toString();
}
