import type { Viewer } from "~/platform/auth/authorize.server";

export type ApplicantMultipartActor = {
  kind: "applicant";
  organisationId: string;
  eventId: string;
  personId: string | null;
  submissionId: string;
  fieldId: string;
};

export type SponsorMultipartActor = {
  kind: "sponsor";
  organisationId: string;
  eventId: string;
  personId: string;
  email: string;
  sponsorId: string;
};
export type MultipartActor =
  | Viewer
  | ApplicantMultipartActor
  | SponsorMultipartActor;
export function isSponsorActor(
  actor: MultipartActor,
): actor is SponsorMultipartActor {
  return "kind" in actor && actor.kind === "sponsor";
}

export type MultipartRow = {
  versionId: string;
  eventId: string;
  organisationId: string;
  assetId: string;
  assetKind: string;
  targetType: string;
  targetId: string;
  sponsorId: string | null;
  ownerPersonId: string | null;
  assetStatus: string;
  erasureRequested: number;
  createdByPersonId: string | null;
  objectKey: string;
  filename: string;
  contentType: string;
  detectedContentType: string | null;
  sizeBytes: number;
  objectEtag: string | null;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  versionDeletedAt: number | null;
  uploadId: string | null;
  idempotencyKey: string;
  status: string;
  partSizeBytes: number;
  manifestJson: string | null;
  manifestHash: string | null;
  lastError: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  filePolicyJson: string;
};
