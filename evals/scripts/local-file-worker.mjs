// Local evaluation entry only. Never included in a production Wrangler profile.
import application from "../../build/server/index.js";
export * from "../../build/server/index.js";
import { localStorageRequest, localPartResponse } from "./local-file-transport.mjs";

export default {
  ...application,
  async fetch(request, env, context) {
    const storage = localStorageRequest(request);
    if (storage) return env.AEK_LOCAL_STORAGE.fetch(storage);
    const response = await application.fetch(request, env, context);
    return localPartResponse(request, response);
  },
};
