import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

export function createDatabase(env: CloudflareEnvironment) {
  if (!env.DB) throw new Error("Required Cloudflare binding DB is unavailable");
  return drizzle(env.DB, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
