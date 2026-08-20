export function isHtmlDocumentRequest(request: Request) {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode === "navigate") return true;
  if (mode === "cors" || mode === "same-origin" || mode === "no-cors") {
    return false;
  }
  const accept = request.headers.get("accept") ?? "";
  return /\btext\/html\b/u.test(accept);
}
