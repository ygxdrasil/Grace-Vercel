/**
 * Where Grace's thinking is billed.
 *
 * She was built against the Gemini API in AI Studio, authenticated with a
 * single key. That worked and cost almost nothing, because the free tier
 * carried her. It stopped working the day the free tier ran out, and the
 * obvious fix — pay for it — turned out to be the one thing the money could
 * not buy.
 *
 * Google's free-trial terms say it outright: "The $300 credit can't pay for
 * Gemini API in AI Studio costs." The credit sits in a Cloud billing account
 * and AI Studio is not billed through one. Same company, same models, same
 * weights, two tills — and only one of them takes the voucher.
 *
 * So she moves to Vertex, which is billed through Cloud and therefore can be
 * paid for out of the credits. Nothing about the models changes. What changes
 * is how she proves who she is: not a key, but a service account signing for a
 * project in a region.
 *
 * Both paths stay live. Vertex when a project is configured, the key when it
 * is not — because the self-test runs on a stub key and no developer should
 * need a Google Cloud project to run Grace on their own machine.
 */

/**
 * The credentials, parsed once.
 *
 * The whole service-account JSON goes into one environment variable rather
 * than being split across three. Splitting it is the documented approach and
 * it is also where this goes wrong for people: the private key is a multi-line
 * PEM block, pasting it into a single-line form field mangles the newlines,
 * and the resulting failure is an opaque signature error that says nothing
 * about newlines. One variable, one paste, no reassembly.
 */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * Newlines survive the round trip.
 *
 * Even pasting the JSON whole, some hosting dashboards store `\n` as the two
 * characters backslash-n. The PEM parser then rejects a key that looks
 * perfectly correct on screen. Repairing it here is two lines and removes an
 * entire category of "it works locally" from the board.
 */
function repairNewlines(pem: string): string {
  return pem.includes('\\n') && !pem.includes('\n')
    ? pem.replace(/\\n/g, '\n')
    : pem;
}

export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw) as ServiceAccount;
  } catch {
    // Loud, and then ignored. A malformed key should not take her offline if
    // an AI Studio key is also present — but it must never fail silently,
    // because the symptom otherwise is "she is inexplicably still on the old
    // billing" and nobody thinks to look at whether the JSON parsed.
    console.error(
      '[grace] GCP_SERVICE_ACCOUNT_JSON is set but is not valid JSON. ' +
        'Paste the whole downloaded file, including the outermost braces.',
    );
    return null;
  }

  if (!parsed.client_email || !parsed.private_key) {
    console.error(
      '[grace] GCP_SERVICE_ACCOUNT_JSON parsed but has no client_email or ' +
        'private_key. That is usually an OAuth client secret rather than a ' +
        'service account key.',
    );
    return null;
  }

  return {...parsed, private_key: repairNewlines(parsed.private_key)};
}

export interface VertexSettings {
  project: string;
  location: string;
  credentials: ServiceAccount;
}

/**
 * Whether she is running on Vertex, and with what.
 *
 * Returns null rather than throwing so the caller can fall back to the key
 * path. Half-configured is treated as not configured, and says which half is
 * missing — because a project with no credentials and credentials with no
 * project fail identically at the network layer, hours later, as a 403.
 */
export function vertexSettings(): VertexSettings | null {
  const project = process.env.GCP_PROJECT_ID?.trim();
  const credentials = serviceAccount();

  if (!project && !credentials) return null;

  if (!project || !credentials) {
    console.error(
      `[grace] Vertex is half-configured: ${
        project ? 'GCP_SERVICE_ACCOUNT_JSON is missing' : 'GCP_PROJECT_ID is missing'
      }. Falling back to the AI Studio key, which the Cloud credits cannot pay for.`,
    );
    return null;
  }

  return {
    project,
    /*
     * Region matters more than it looks, and `global` is not a cop-out.
     *
     * The newest Flash models — 3.6, 3.7, 3.8 — are served only from the
     * global region. The EU-pinned regions (europe-west4 and friends) exist
     * to guarantee data residency and the price of that guarantee is being a
     * generation behind: they top out at 3.5 Flash.
     *
     * Getting this wrong is genuinely nasty to debug, because Google answers
     * a model that is absent from a region with the same 403 as a model you
     * lack permission for — "denied on resource ... (or it may not exist)".
     * One message, two completely different causes, and the obvious reading
     * is the wrong one. This defaulted to europe-west4 and cost an hour.
     *
     * So: global, because the choice made here was the best models. Set
     * GCP_LOCATION to europe-west4 to pin the data to the EU instead, and
     * expect to drop to gemini-3.5-flash when you do — a newer model will
     * simply 403.
     */
    location: process.env.GCP_LOCATION?.trim() || 'global',
    credentials,
  };
}
