import { z } from "zod";

import {
  parseResourceDocument,
  validateResourceDocumentEmbedStructure,
  type TiptapNode,
} from "./resource-content";

export type ResourceExternalEmbedDraft = {
  kind: "video" | "map";
  videoUrl: string;
  mapMode: "place" | "search";
  mapQuery: string;
};

export type ResourceRecoveryPayload = {
  title: string;
  slug: string;
  category: string;
  audienceScope: "all_speakers" | "accepted_speakers" | "custom";
  audiencePersonIds: string[];
  acknowledgementRequired: boolean;
  document: TiptapNode;
  externalEmbedDraft: ResourceExternalEmbedDraft;
};

export const emptyResourceExternalEmbedDraft: ResourceExternalEmbedDraft = {
  kind: "video",
  videoUrl: "",
  mapMode: "place",
  mapQuery: "",
};

const recoveryPayloadSchema = z
  .object({
    title: z.string(),
    slug: z.string(),
    category: z.string(),
    audienceScope: z.enum(["all_speakers", "accepted_speakers", "custom"]),
    audiencePersonIds: z.array(z.string()),
    acknowledgementRequired: z.boolean(),
    document: z.unknown(),
    externalEmbedDraft: z
      .object({
        kind: z.enum(["video", "map"]),
        videoUrl: z.string(),
        mapMode: z.enum(["place", "search"]),
        mapQuery: z.string(),
      })
      .strict()
      .superRefine((draft, context) => {
        const inactiveValue =
          draft.kind === "video" ? draft.mapQuery : draft.videoUrl;
        if (inactiveValue.trim()) {
          context.addIssue({
            code: "custom",
            message: "The inactive external-content draft must be empty.",
          });
        }
      }),
  })
  .strict();

export function parseResourceRecoveryPayload(
  raw: unknown,
): ResourceRecoveryPayload {
  const parsed = recoveryPayloadSchema.parse(raw);
  const document = parseResourceDocument(parsed.document);
  validateResourceDocumentEmbedStructure(document);
  return { ...parsed, document };
}

export function isResourceRecoveryPayload(
  raw: unknown,
): raw is ResourceRecoveryPayload {
  try {
    parseResourceRecoveryPayload(raw);
    return true;
  } catch {
    return false;
  }
}
