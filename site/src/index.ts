/*
 * Program Cue public website (programcue.com).
 *
 * Deliberately a separate Worker from the application on app.programcue.com.
 * These pages must answer 200 to anonymous visitors, Google's OAuth reviewers
 * and search crawlers, so they never touch sessions, D1 or any authorisation
 * path that could redirect a signed-out request to a sign-in screen.
 *
 * The site is static HTML with no scripts, so the policy below is a genuine
 * deny list rather than an aspiration: script-src and connect-src are 'none'.
 */

const CANONICAL_HOST = "programcue.com";
const PUBLIC_HOSTS = new Set([CANONICAL_HOST, `www.${CANONICAL_HOST}`]);
const READ_METHODS = new Set(["GET", "HEAD"]);
/* Exact hash of the canonical brand-mark.svg style block. This permits its
   adaptive light/dark fills without allowing arbitrary inline site styles. */
const BRAND_MARK_STYLE_HASH =
  "'sha256-y0BNy4M/KDhas6W22Ivuu4JFcXstAw0DS7LRMKA75k8='";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  `style-src 'self' ${BRAND_MARK_STYLE_HASH}`,
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

/* Mirrors app/platform/http/security-headers.ts so both origins answer with
   the same posture. HSTS omits includeSubDomains for the same reason it does
   there: app. and scanner. set their own. */
const SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
} as const;

interface SiteEnvironment {
  ASSETS: Fetcher;
}

export function canonicalRedirectTarget(url: URL): string | undefined {
  if (!PUBLIC_HOSTS.has(url.hostname)) return undefined;
  if (url.hostname === CANONICAL_HOST && url.protocol === "https:")
    return undefined;
  const target = new URL(url.toString());
  target.protocol = "https:";
  target.hostname = CANONICAL_HOST;
  target.port = "";
  return target.toString();
}

/* `wrangler dev` evaluates configured Custom Domains while proxying them
   through Miniflare, so the URL and Host header both name production. Its
   loopback connection marker is the remaining reliable local signal. Do not
   turn that development proxy into a redirect loop. */
function isLocalDevelopmentProxy(request: Request, url: URL) {
  const connectingIp = request.headers.get("cf-connecting-ip");
  return (
    (connectingIp === "127.0.0.1" || connectingIp === "::1") &&
    request.headers.has("mf-original-hostname") &&
    PUBLIC_HOSTS.has(url.hostname)
  );
}

export function applySiteSecurityHeaders(headers: Headers, url: URL) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  /* Only meaningful over TLS, and asserting it on a `wrangler dev` localhost
     origin would pin the developer's browser to HTTPS there. */
  if (url.protocol === "https:")
    headers.set("strict-transport-security", "max-age=31536000");
}

export default {
  async fetch(request: Request, env: SiteEnvironment): Promise<Response> {
    const url = new URL(request.url);

    if (!READ_METHODS.has(request.method)) {
      const headers = new Headers({
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
      });
      applySiteSecurityHeaders(headers, url);
      return new Response("Method Not Allowed\n", { status: 405, headers });
    }

    const redirect = isLocalDevelopmentProxy(request, url)
      ? undefined
      : canonicalRedirectTarget(url);
    if (redirect) {
      const headers = new Headers({
        location: redirect,
        "cache-control": "public, max-age=3600",
      });
      applySiteSecurityHeaders(headers, url);
      return new Response(null, { status: 301, headers });
    }

    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    applySiteSecurityHeaders(response.headers, url);
    return response;
  },
} satisfies ExportedHandler<SiteEnvironment>;
