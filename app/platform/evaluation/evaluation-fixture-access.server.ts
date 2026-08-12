const MINIMUM_SECRET_LENGTH = 32;

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export class EvaluationFixtureAccessConfigurationError extends Error {
  constructor() {
    super("EVALUATION_FIXTURE_SECRET must contain at least 32 characters.");
    this.name = "EvaluationFixtureAccessConfigurationError";
  }
}

export async function requireEvaluationFixtureAccess(
  request: Request,
  configuredSecret: string | undefined,
) {
  const expected = configuredSecret?.trim() ?? "";
  if (!expected) throw new Response("Not found", { status: 404 });
  if (expected.length < MINIMUM_SECRET_LENGTH) {
    throw new EvaluationFixtureAccessConfigurationError();
  }

  const supplied = bearerToken(request);
  if (!supplied) throw new Response("Forbidden", { status: 403 });

  const [expectedDigest, suppliedDigest] = await Promise.all([
    digest(expected),
    digest(supplied),
  ]);
  let mismatch = expectedDigest.length ^ suppliedDigest.length;
  const length = Math.max(expectedDigest.length, suppliedDigest.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (expectedDigest[index] ?? 0) ^ (suppliedDigest[index] ?? 0);
  }
  if (mismatch !== 0) throw new Response("Forbidden", { status: 403 });
}
