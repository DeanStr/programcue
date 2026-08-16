import { DEMO_EVENT_ID } from "~/platform/demo/demo-identities";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export function apiReferenceBackLink(env: CloudflareEnvironment) {
  const runtime = requireRuntimeMode(env);
  if (runtime.evaluation) {
    return { label: "Evaluation access", to: "/evaluate" } as const;
  }
  if (runtime.demo && env.DEFAULT_EVENT_ID === DEMO_EVENT_ID) {
    return { label: "Demo guide", to: "/demo" } as const;
  }
  return { label: "API settings", to: "/admin/settings" } as const;
}
