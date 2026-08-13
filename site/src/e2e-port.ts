type PortEnvironment = Readonly<Record<string, string | undefined>>;

function parsePort(value: string, name: string) {
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  const port = Number(value);
  if (port < 1 || port > 65_535)
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  return port;
}

export function resolveSiteE2ePort(environment: PortEnvironment) {
  const explicit = environment.PROGRAM_CUE_SITE_E2E_PORT;
  if (explicit !== undefined)
    return parsePort(explicit, "PROGRAM_CUE_SITE_E2E_PORT");

  const applicationPort = environment.PROGRAM_CUE_E2E_PORT;
  if (applicationPort === undefined) return 8788;

  const derived = parsePort(applicationPort, "PROGRAM_CUE_E2E_PORT") + 1000;
  if (derived > 65_535)
    throw new Error(
      "PROGRAM_CUE_E2E_PORT is too high to derive the public-site test port; set PROGRAM_CUE_SITE_E2E_PORT explicitly.",
    );
  return derived;
}
