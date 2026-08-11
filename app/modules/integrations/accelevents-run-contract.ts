import { z } from "zod";

export const acceleventsRunItemDiffSchema = z
  .object({
    label: z.string(),
    payload: z.unknown(),
    sourceHash: z.string().length(64),
    previousExternalId: z.string().nullable(),
    changes: z.array(
      z.object({
        field: z.string(),
        before: z.unknown(),
        after: z.unknown(),
      }),
    ),
    providerSupport: z.enum(["supported", "blocked"]),
    providerMessage: z.string().nullable(),
  })
  .strict();

export const acceleventsTerminalRunStatuses = [
  "succeeded",
  "partially_failed",
  "failed",
  "cancelled",
] as const;

export function isAcceleventsTerminalRunStatus(
  status: string,
): status is (typeof acceleventsTerminalRunStatuses)[number] {
  return (acceleventsTerminalRunStatuses as readonly string[]).includes(status);
}
