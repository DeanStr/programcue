import { z } from "zod";

export const crmStages = [
  "identified",
  "contacted",
  "interested",
  "confirmed",
  "declined",
] as const;

export const crmStageSchema = z.enum(crmStages);
export type CrmStage = z.infer<typeof crmStageSchema>;

export const crmFiltersSchema = z
  .object({
    query: z.string().trim().max(120).default(""),
    company: z.string().trim().max(160).default(""),
    jobTitle: z.string().trim().max(160).default(""),
    tag: z.string().trim().max(40).default(""),
  })
  .strict();

export type CrmFilters = z.infer<typeof crmFiltersSchema>;

export const crmPersonIdSchema = z.string().trim().min(1).max(200);

export const createCrmContactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
  jobTitle: z.string().trim().max(160).default(""),
  organisationName: z.string().trim().max(160).default(""),
  biography: z.string().trim().max(5_000).default(""),
});
