export const localMailSendUrl = "http://127.0.0.1:8025/api/v1/send";

// Miniflare requests belong to a different Fetch implementation from Node.
// Copy the request explicitly, and never follow a redirect out of local capture.
export async function sendLocalMail(request, fetcher = fetch) {
  if (request.url !== localMailSendUrl || request.method !== "POST")
    throw new Error("Local mail transport accepts only POST to the fixed Mailpit send endpoint");
  return fetcher(localMailSendUrl, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
    redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
  });
}
