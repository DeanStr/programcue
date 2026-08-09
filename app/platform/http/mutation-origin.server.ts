const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function rejectCrossOriginBrowserMutation(request: Request) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return null;

  const origin = request.headers.get("origin");
  if (origin === url.origin) return null;

  return new Response("A same-origin request is required.", {
    status: 403,
    headers: { "cache-control": "no-store" },
  });
}
