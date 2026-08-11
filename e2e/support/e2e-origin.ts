const configuredPort = process.env.PROGRAM_CUE_E2E_PORT?.trim() || "5173";
const port = Number(configuredPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `PROGRAM_CUE_E2E_PORT must be an integer from 1 to 65535; received ${JSON.stringify(configuredPort)}.`,
  );
}

export const e2eOrigin = `http://127.0.0.1:${port}`;
