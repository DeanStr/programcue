import { sql } from "drizzle-orm";

export const epochNow = sql`(unixepoch())`;
