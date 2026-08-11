export { ProgramCueEventAgent } from "./program-cue-agent.server";

export default {
  fetch() {
    return new Response("Program Cue Agent test worker");
  },
};
