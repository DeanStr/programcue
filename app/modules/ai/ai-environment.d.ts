export {};

declare global {
  interface CloudflareEnvironment {
    AI?: Ai;
    OPENAI_API_KEY?: string;
    OPENAI_RESPONSES_URL?: string;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_MESSAGES_URL?: string;
    PROGRAM_CUE_AGENT?: DurableObjectNamespace<
      import("./program-cue-agent.server").ProgramCueEventAgent
    >;
  }
}
