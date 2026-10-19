export type SponsorAsset = {
  id: string;
  sponsorId: string;
  name: string;
  kind: "logo" | "document";
  required: number;
  revision: number;
  reviewStatus: "pending" | "approved" | "changes_requested";
  reviewNote: string;
  reviewedVersionId: string | null;
  versionId: string | null;
  filename: string | null;
  uploadStatus: string | null;
  uploadExpiresAt: number | null;
  scanStatus: string | null;
  releasedAt: number | null;
};
export function sponsorAssetState(
  a: SponsorAsset,
  now = Math.floor(Date.now() / 1000),
) {
  if (!a.versionId) return "missing";
  if (
    ["failed", "aborted"].includes(a.uploadStatus ?? "") ||
    ["failed", "infected"].includes(a.scanStatus ?? "")
  )
    return "upload_failed";
  if (
    a.uploadStatus !== "uploaded" &&
    a.uploadExpiresAt !== null &&
    a.uploadExpiresAt <= now
  )
    return "upload_expired";
  if (a.uploadStatus !== "uploaded") return "uploading";
  if (!a.releasedAt || a.scanStatus !== "clean") return "scanning";
  if (a.reviewedVersionId !== a.versionId) return "review";
  return a.reviewStatus === "approved"
    ? "approved"
    : a.reviewStatus === "changes_requested"
      ? "changes_requested"
      : "review";
}
export const SPONSOR_ASSET_LABELS: Record<
  ReturnType<typeof sponsorAssetState>,
  string
> = {
  missing: "Missing",
  upload_failed: "Upload needs attention",
  upload_expired: "Upload expired. Choose the file again to restart.",
  uploading: "Upload in progress",
  scanning: "Awaiting file checks",
  review: "Awaiting organiser review",
  approved: "Approved",
  changes_requested: "Changes requested",
};
