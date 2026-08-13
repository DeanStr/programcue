export type RuntimeAppEnvironment =
  "production" | "demo" | "development" | "test";

export type RuntimeMode = {
  appEnvironment: RuntimeAppEnvironment;
  demo: boolean;
  evaluation: boolean;
};

type RuntimeModeEnvironment = {
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
  EVALUATION_MODE?: unknown;
};

const allowedModes = new Map<string, RuntimeMode>([
  [
    "production:false:false",
    { appEnvironment: "production", demo: false, evaluation: false },
  ],
  [
    "production:false:true",
    { appEnvironment: "production", demo: false, evaluation: true },
  ],
  [
    "demo:true:false",
    { appEnvironment: "demo", demo: true, evaluation: false },
  ],
  [
    "development:true:false",
    { appEnvironment: "development", demo: true, evaluation: false },
  ],
  [
    "test:true:false",
    { appEnvironment: "test", demo: true, evaluation: false },
  ],
]);

export class RuntimeEnvironmentConfigurationError extends Error {
  constructor(
    appEnvironment: unknown,
    demoMode: unknown,
    evaluationMode: unknown,
  ) {
    super(
      `Unsupported APP_ENV/DEMO_MODE/EVALUATION_MODE combination: ${String(appEnvironment)}/${String(demoMode)}/${String(evaluationMode)}`,
    );
    this.name = "RuntimeEnvironmentConfigurationError";
  }
}

export function requireRuntimeMode(
  environment: RuntimeModeEnvironment,
): RuntimeMode {
  const key = `${String(environment.APP_ENV)}:${String(environment.DEMO_MODE)}:${String(environment.EVALUATION_MODE)}`;
  const mode = allowedModes.get(key);
  if (!mode) {
    throw new RuntimeEnvironmentConfigurationError(
      environment.APP_ENV,
      environment.DEMO_MODE,
      environment.EVALUATION_MODE,
    );
  }
  return mode;
}

export function requiresProductionSecurity(appEnvironment: unknown) {
  return (
    appEnvironment !== "demo" &&
    appEnvironment !== "development" &&
    appEnvironment !== "test"
  );
}

export function mayExposeInternalErrors(appEnvironment: unknown) {
  return !requiresProductionSecurity(appEnvironment);
}
