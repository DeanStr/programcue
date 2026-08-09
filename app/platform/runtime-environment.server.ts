export type RuntimeAppEnvironment = "production" | "demo" | "development" | "test";

export type RuntimeMode = {
  appEnvironment: RuntimeAppEnvironment;
  demo: boolean;
};

type RuntimeModeEnvironment = {
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
};

const allowedModes = new Map<string, RuntimeMode>([
  ["production:false", { appEnvironment: "production", demo: false }],
  ["demo:true", { appEnvironment: "demo", demo: true }],
  ["development:true", { appEnvironment: "development", demo: true }],
  ["test:true", { appEnvironment: "test", demo: true }],
]);

export class RuntimeEnvironmentConfigurationError extends Error {
  constructor(appEnvironment: unknown, demoMode: unknown) {
    super(`Unsupported APP_ENV/DEMO_MODE combination: ${String(appEnvironment)}/${String(demoMode)}`);
    this.name = "RuntimeEnvironmentConfigurationError";
  }
}

export function requireRuntimeMode(environment: RuntimeModeEnvironment): RuntimeMode {
  const key = `${String(environment.APP_ENV)}:${String(environment.DEMO_MODE)}`;
  const mode = allowedModes.get(key);
  if (!mode) {
    throw new RuntimeEnvironmentConfigurationError(environment.APP_ENV, environment.DEMO_MODE);
  }
  return mode;
}

export function requiresProductionSecurity(appEnvironment: unknown) {
  return appEnvironment !== "demo"
    && appEnvironment !== "development"
    && appEnvironment !== "test";
}

export function mayExposeInternalErrors(appEnvironment: unknown) {
  return !requiresProductionSecurity(appEnvironment);
}
