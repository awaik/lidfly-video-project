const SECRET_QUERY_KEYS =
  /(?:token|key|secret|signature|credential|auth|password|session|cookie|expires?)/i;
const SECRET_FIELD_KEYS =
  /authorization|api[_-]?key|auth[_-]?token|access[_-]?token|password|secret|session|cookie/i;

export function redactUrl(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return raw;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return redactUrl(value);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_KEYS.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}

export class ProviderError extends Error {
  constructor(message, { status = null, code = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details ? redact(details) : null;
  }
}

export async function providerErrorFromResponse(response, context) {
  let body = null;
  try {
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text ? { message: text.slice(0, 500) } : null;
    }
  } catch {
    body = null;
  }
  const error = body?.error;
  const message = error?.message || body?.message || `${context} failed`;
  const code = error?.code || body?.code || null;
  return new ProviderError(`${context} HTTP ${response.status}: ${message}`, {
    status: response.status,
    code,
    retryable: response.status === 429 || response.status >= 500,
    details: body,
  });
}
