import { z } from "zod";
import { type SponsorAsset, sponsorAssetState } from "./sponsor-assets";
export const sponsorFiltersSchema = z.object({
  q: z.string().trim().max(120).default(""),
  state: z
    .enum(["all", "invitation", "sessions", "assets", "review", "due", "ready"])
    .default("all"),
});
export type SponsorFilters = z.infer<typeof sponsorFiltersSchema>;
export function sponsorReadiness(
  input: {
    sessionLimit: number;
    closesAt: number | null;
    contacts: {
      acceptedAt: number | null;
      revokedAt: number | null;
      name: string;
      email: string;
    }[];
    proposals: { status: string }[];
    assets: SponsorAsset[];
  },
  now: number,
) {
  const contacts = input.contacts.filter((c) => c.revokedAt === null);
  const accepted = contacts.filter((c) => c.acceptedAt !== null);
  const submitted = input.proposals.filter((p) =>
    ["submitted", "accepted"].includes(p.status),
  ).length;
  const approved = input.proposals.filter(
    (p) => p.status === "accepted",
  ).length;
  const missingSessions = Math.max(0, input.sessionLimit - submitted);
  const required = input.assets.filter((a) => a.required);
  const actionableAssets = required.filter((a) =>
    [
      "missing",
      "upload_failed",
      "upload_expired",
      "changes_requested",
    ].includes(sponsorAssetState(a, now)),
  );
  const assetReview = input.assets.filter(
    (a) => sponsorAssetState(a, now) === "review",
  ).length;
  const sessionReview = input.proposals.filter(
    (p) => p.status === "submitted",
  ).length;
  const outstandingAssets = required.filter(
    (a) => sponsorAssetState(a, now) !== "approved",
  ).length;
  const closed = input.closesAt !== null && input.closesAt <= now;
  const waitingOnSponsor =
    !accepted.length || missingSessions > 0 || actionableAssets.length > 0;
  const ready =
    accepted.length > 0 &&
    approved >= input.sessionLimit &&
    outstandingAssets === 0;
  return {
    contacts: contacts.length,
    acceptedContacts: accepted.length,
    submitted,
    approved,
    missingSessions,
    outstandingAssets,
    actionableAssets: actionableAssets.length,
    assetReview,
    sessionReview,
    closed,
    ready,
    due: !ready && input.closesAt !== null && input.closesAt <= now + 7 * 86400,
    recipients:
      !closed && waitingOnSponsor
        ? !accepted.length
          ? contacts
          : accepted
        : [],
  };
}
export function matchesSponsorReadiness(
  row: { name: string; readiness: ReturnType<typeof sponsorReadiness> },
  filter: SponsorFilters,
) {
  if (!row.name.toLocaleLowerCase().includes(filter.q.toLocaleLowerCase()))
    return false;
  const r = row.readiness;
  switch (filter.state) {
    case "invitation":
      return r.acceptedContacts === 0;
    case "sessions":
      return r.missingSessions > 0;
    case "assets":
      return r.actionableAssets > 0;
    case "review":
      return r.assetReview + r.sessionReview > 0;
    case "due":
      return r.due;
    case "ready":
      return r.ready;
    default:
      return true;
  }
}
