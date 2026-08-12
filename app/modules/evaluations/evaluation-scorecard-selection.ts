import { z } from "zod";

const scorecardSelectionPayloadSchema = z
  .object({
    scorecardId: z.string().trim().min(1).max(120),
    scorecardVersion: z.number().int().positive(),
  })
  .strict();

export class ScorecardSelectionError extends Error {
  constructor() {
    super("Choose a valid scorecard version.");
    this.name = "ScorecardSelectionError";
  }
}

export function encodeScorecardSelection(
  scorecardId: string,
  scorecardVersion: number,
) {
  return JSON.stringify({ scorecardId, scorecardVersion });
}

export function parseScorecardSelection(value: FormDataEntryValue | null) {
  if (value === null || value === "") {
    return { scorecardId: null, scorecardVersion: undefined } as const;
  }
  if (typeof value !== "string") throw new ScorecardSelectionError();

  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new ScorecardSelectionError();
  }
  const parsed = scorecardSelectionPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ScorecardSelectionError();
  return parsed.data;
}
