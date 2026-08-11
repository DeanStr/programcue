const CF_RAY_PATTERN = /^[0-9a-f]{16,32}(?:-[A-Z0-9]{3})?$/i;
const CALLER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validCorrelationId(value: string | null, pattern: RegExp) {
  const candidate = value?.trim() ?? "";
  return pattern.test(candidate) ? candidate : null;
}

/**
 * Cloudflare's Ray ID is the preferred request trace. A caller correlation ID
 * is accepted only when it is a machine-shaped UUID, so free-form personal
 * data and log-forging payloads cannot enter responses or logs.
 */
export function requestCorrelationId(request: Request) {
  return (
    validCorrelationId(request.headers.get("cf-ray"), CF_RAY_PATTERN) ??
    validCorrelationId(
      request.headers.get("x-correlation-id"),
      CALLER_UUID_PATTERN,
    ) ??
    crypto.randomUUID()
  );
}
