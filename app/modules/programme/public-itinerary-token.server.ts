const encoder = new TextEncoder();
const COOKIE_VERSION = "v2";
const COOKIE_LIFETIME_SECONDS = 5 * 365 * 86_400;
const BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){2}$/u;

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

function secret(env: CloudflareEnvironment) {
  const value = String(env.ANONYMOUS_ITINERARY_SECRET ?? "").trim();
  if (value.length < 32) {
    throw new Error(
      "Anonymous itineraries require ANONYMOUS_ITINERARY_SECRET with at least 32 characters.",
    );
  }
  if (value === String(env.BETTER_AUTH_SECRET ?? "").trim()) {
    throw new Error(
      "ANONYMOUS_ITINERARY_SECRET must be independent from BETTER_AUTH_SECRET.",
    );
  }
  return value;
}

function safeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

export async function signItineraryBrowserCookie(
  env: CloudflareEnvironment,
  browserId: string,
  now = Math.floor(Date.now() / 1_000),
) {
  if (!BROWSER_ID_PATTERN.test(browserId)) {
    throw new Error("The anonymous itinerary browser identifier is invalid.");
  }
  const expiresAt = now + COOKIE_LIFETIME_SECONDS;
  const payload = `${COOKIE_VERSION}.${browserId}.${expiresAt}`;
  const signature = base64Url(
    await hmac(secret(env), `itinerary-cookie\0${payload}`),
  );
  return { value: `${payload}.${signature}`, expiresAt };
}

export async function verifyItineraryBrowserCookie(
  env: CloudflareEnvironment,
  value: string | null,
  now = Math.floor(Date.now() / 1_000),
) {
  if (!value) return null;
  const [version, browserId, rawExpiresAt, suppliedSignature, ...extra] =
    value.split(".");
  if (
    extra.length ||
    version !== COOKIE_VERSION ||
    !browserId ||
    !BROWSER_ID_PATTERN.test(browserId) ||
    !rawExpiresAt ||
    !/^[0-9]+$/u.test(rawExpiresAt) ||
    !suppliedSignature
  ) {
    return null;
  }
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const payload = `${version}.${browserId}.${rawExpiresAt}`;
  const expectedSignature = base64Url(
    await hmac(secret(env), `itinerary-cookie\0${payload}`),
  );
  return safeEqual(suppliedSignature, expectedSignature) ? browserId : null;
}

export async function eventVisitorKeyHash(
  env: CloudflareEnvironment,
  browserId: string,
  eventId: string,
) {
  if (!BROWSER_ID_PATTERN.test(browserId)) {
    throw new Error("The anonymous itinerary browser identifier is invalid.");
  }
  if (!eventId.trim())
    throw new Error("An event is required for an itinerary.");
  return `${COOKIE_VERSION}.${base64Url(
    await hmac(secret(env), `itinerary-database\0${eventId}\0${browserId}`),
  )}`;
}
