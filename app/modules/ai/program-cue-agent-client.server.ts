import { getAgentByName } from "agents";

import { programCueAgentInstanceName } from "./program-cue-agent.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export class AiAgentRuntimeConfigurationError extends Error {
  constructor() {
    super(
      "The PROGRAM_CUE_AGENT Durable Object binding is required for the event assistant.",
    );
    this.name = "AiAgentRuntimeConfigurationError";
  }
}

export async function getProgramCueEventAgent(
  env: CloudflareEnvironment,
  viewer: Viewer,
) {
  if (!env.PROGRAM_CUE_AGENT) throw new AiAgentRuntimeConfigurationError();
  return getAgentByName(
    env.PROGRAM_CUE_AGENT,
    await programCueAgentInstanceName(viewer),
  );
}
