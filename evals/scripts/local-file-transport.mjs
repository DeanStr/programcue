// The original signed virtual S3 URL remains the authority. Only its local
// transport address changes; no bytes, signatures or provider results are made up.
const storageOrigin = "https://00000000000000000000000000000000.r2.cloudflarestorage.com";
const prefix = "/__eval/private-storage";

function localOrigin(url) {
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("Local storage transport requires a loopback HTTP application");
}

export function localStorageRequest(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  localOrigin(url);
  const original = new URL(storageOrigin);
  original.pathname = url.pathname.slice(prefix.length);
  original.search = url.search;
  return new Request(original, request);
}

export async function localPartResponse(request, response) {
  const url = new URL(request.url);
  if (url.pathname !== "/files/multipart/part-url" || !response.ok) return response;
  localOrigin(url);
  const body = await response.json();
  const signed = new URL(body.part.url);
  if (signed.origin !== storageOrigin || signed.username || signed.password || signed.hash)
    throw new Error("Unexpected private storage authority in the local upload response");
  body.part.url = `${url.origin}${prefix}${signed.pathname}${signed.search}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
