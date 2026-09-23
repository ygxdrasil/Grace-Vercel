/**
 * A model error, as a sentence a person can act on.
 *
 * Google's SDK throws with the whole response body as the message, and the
 * body is JSON whose `message` is often itself JSON — so what reached the
 * screen was a wall of escaped braces with the one useful phrase buried in
 * the middle. The full text still goes to the terminal; this is for the HUD.
 */

interface Found {
  message: string;
  status: string;
  code: number;
}

/** Digs through nested `{"error":{"message":"{...}"}}` for the innermost facts. */
function dig(text: string, depth = 0): Found {
  const found: Found = {message: text, status: '', code: 0};
  if (depth > 4) return found;
  const start = text.indexOf('{');
  if (start < 0) return found;
  try {
    const body = JSON.parse(text.slice(start)) as {
      error?: {message?: unknown; status?: unknown; code?: unknown};
    };
    const error = body.error ?? (body as Found);
    const message = typeof error.message === 'string' ? error.message : text;
    const inner = message.includes('{') ? dig(message, depth + 1) : null;
    return {
      message: inner?.message ?? message,
      status: inner?.status || (typeof error.status === 'string' ? error.status : ''),
      code: inner?.code || (typeof error.code === 'number' ? error.code : 0),
    };
  } catch {
    return found;
  }
}

/**
 * The cause, when it is one of the ones a person can do something about.
 * Null when it is not — the caller then knows better what to say.
 */
export function knownCause(raw: string): string | null {
  const {message, status, code} = dig(raw);
  const all = `${raw} ${message} ${status}`;

  if (/API_KEY_INVALID|API key not valid|UNAUTHENTICATED|invalid_grant|PERMISSION_DENIED/i.test(all) ||
      code === 401 || code === 403) {
    return 'Google refused the key she thinks with. Check the service-account file, or Config → Keys.';
  }
  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(all) || code === 429) {
    return 'Google is rate-limiting her for a moment. Try again in a few seconds.';
  }
  if (code === 404 || /NOT_FOUND|was not found|does not exist/i.test(all)) {
    const model = /models\/([\w.-]+)/.exec(all)?.[1] ?? /(gemini-[\w.-]+)/.exec(all)?.[1];
    return model
      ? `The model "${model}" isn't available to her. It may be misnamed or not enabled in this region.`
      : 'Something she asked Google for does not exist.';
  }
  if (/UNAVAILABLE|overloaded|503|502|INTERNAL/i.test(all) || code >= 500) {
    return "Google's side is struggling right now. Try again in a moment.";
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|network/i.test(all)) {
    return "She couldn't reach Google. Is the internet connection up?";
  }
  if (/DEADLINE|timed? ?out|aborted/i.test(all)) {
    return 'That took too long and was cut off.';
  }
  return null;
}

export function plainly(raw: string): string {
  const known = knownCause(raw);
  if (known) return known;
  const flat = dig(raw).message.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat || 'unknown error';
}
