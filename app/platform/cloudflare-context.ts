import { createContext, type RouterContextProvider } from "react-router";

export type CloudflareRequestContext = {
  env: CloudflareEnvironment;
  ctx: ExecutionContext;
};

export const cloudflareContext = createContext<CloudflareRequestContext>();

export function getCloudflareContext(context: Readonly<RouterContextProvider>) {
  return context.get(cloudflareContext);
}
