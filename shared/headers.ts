/**
 * The headers every response carries, and why each one is there.
 *
 * Kept in one place because they have to be set twice and must not drift: the
 * API is served by Express, but on Vercel the page, the bundle and the icons
 * come off a CDN that never touches this code — so vercel.json declares the
 * same list, and a test proves the two agree.
 *
 * She sits behind a password and holds mail, a diary, a house's lights and an
 * API key with a monthly bill attached. None of these headers is exotic; the
 * point is that all of them are boring, and she had none of them.
 */

/**
 * What a page is allowed to load, and from where.
 *
 * Each entry below is the narrowest that leaves her working. That was
 * established by reading the built bundle rather than by guessing, which is
 * how the two surprises turned up:
 *
 *   - There is exactly one inline script, four lines that set the theme
 *     before the first paint so daylight mode does not begin with a black
 *     flash. React cannot do that job — by the time it mounts the frame is
 *     already drawn. It needs `unsafe-inline`, which is a real weakening and
 *     an honest trade: it permits inline script, while `'self'` still stops
 *     any script being loaded from somewhere else. She renders no HTML from
 *     mail or the web, so the usual way that weakness gets exploited is not
 *     open to begin with.
 *   - Her typefaces are imported from Google inside the stylesheet, so the
 *     style and font sources have to name them or she loses her lettering.
 *
 * `blob:` for media is her own voice: speech arrives as base64, becomes a
 * Blob, and is played from a blob URL.
 */
/**
 * Where the machine holding her voice can be reached.
 *
 * Hardcoded on purpose. The CDN serves the page without ever running this
 * code, so the policy has to be a constant in both places rather than
 * something read from the environment — which is exactly why a test asserts
 * that this and the configured outpost are the same host.
 */
export const OUTPOST = 'wss://35-228-41-171.nip.io';

const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  /*
   * Her voice lives on another machine, so 'self' is not enough.
   *
   * This was 'self' alone, which reads as correct and quietly broke the
   * feature it was written before: the browser holds a socket open to the
   * outpost, and that is a different origin. The connection was refused, she
   * fell back to recording and replying, and the fallback works well enough
   * that it looked like success. A security header that silently disables a
   * feature is worse than one that breaks it loudly.
   *
   * Named explicitly rather than allowing `wss:` generally. The address is
   * reserved and does not change on its own; if the outpost ever moves, this
   * has to move with it, and the self-test below fails if it does not.
   */
  `connect-src 'self' ${OUTPOST}`,
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing may put her in a frame. An assistant that spends money and works
  // the lights, rendered invisibly over someone else's page, is a clickjacking
  // target with unusually concrete consequences.
  "frame-ancestors 'none'",
].join('; ');

/**
 * The same policy, for a Grace running on the machine in front of you.
 *
 * Her voice is held open by a socket, and when she is local that socket is to
 * her own machine rather than to a reserved address in Sweden. The deployed
 * policy is left untouched — it has to stay literally identical to the copy in
 * vercel.json, which a test proves — so this widens `connect-src` only, and
 * only to this machine.
 *
 * `ws://localhost` looks like a weakening and is not much of one. Anything
 * that could open that socket is already running on the computer, which is a
 * position from which the browser's rules are the least of the problem.
 */
export function localPolicy(): string {
  return POLICY.replace(
    `connect-src 'self' ${OUTPOST}`,
    `connect-src 'self' ${OUTPOST} ws://localhost:* ws://127.0.0.1:*`,
  );
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': POLICY,

  /**
   * Stops a browser second-guessing a Content-Type. Without it a file she
   * stores and later serves can be sniffed into being script.
   */
  'X-Content-Type-Options': 'nosniff',

  /** The older half of frame-ancestors, for anything that predates CSP. */
  'X-Frame-Options': 'DENY',

  /**
   * Her URLs are plain, but a referrer still leaks that you use her at all,
   * and to whom. Same-origin navigation keeps the full path; anything leaving
   * gets the bare origin.
   */
  'Referrer-Policy': 'strict-origin-when-cross-origin',

  /**
   * The microphone stays, because it is how you talk to her. Everything else
   * a browser might hand out is refused outright — she has never needed a
   * camera or your location, and a permission that is never requested is one
   * that cannot be granted by mistake.
   */
  'Permissions-Policy':
    'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), midi=()',
};
