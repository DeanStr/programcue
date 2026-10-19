import { Form, useRevalidator } from "react-router";
import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import { Button, ButtonAnchor, ButtonLink } from "~/components/ui/button";
import type { EventFilePolicy } from "~/modules/files/file-policy";
import {
  SPONSOR_ASSET_LABELS,
  type SponsorAsset,
  sponsorAssetState,
} from "~/modules/sponsors/sponsor-assets";
export function SponsorAssets({
  assets,
  eventId,
  sponsorId,
  companyProfile,
  commandKey,
  admin = false,
  closed = false,
  busy = false,
  filePolicy,
}: {
  assets: SponsorAsset[];
  eventId: string;
  sponsorId: string;
  companyProfile: {
    name: string;
    tier: string;
    description: string;
    websiteUrl: string;
  };
  commandKey: string;
  admin?: boolean;
  closed?: boolean;
  busy?: boolean;
  filePolicy: EventFilePolicy;
}) {
  const revalidator = useRevalidator();
  const hidden = (intent: string, a?: SponsorAsset) => (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="key" value={commandKey} />
      <input type="hidden" name="sponsorId" value={sponsorId} />
      <input type="hidden" name="requestId" value={a?.id ?? ""} />
      <input type="hidden" name="versionId" value={a?.versionId ?? ""} />
      <input type="hidden" name="revision" value={a?.revision ?? 1} />
    </>
  );
  return (
    <section className="card pad stack" aria-label="Sponsor assets">
      <h2>Sponsor assets</h2>
      <p>
        Files stay private while they are checked and reviewed. Only an approved
        logo explicitly selected by the organiser can appear on the published
        event website.
      </p>
      {assets.some((a) =>
        ["scanning", "uploading"].includes(sponsorAssetState(a)),
      ) && (
        <Button
          type="button"
          disabled={revalidator.state !== "idle"}
          onClick={() => revalidator.revalidate()}
        >
          Refresh file status
        </Button>
      )}
      {!assets.length && <p>No assets requested.</p>}
      {assets.map((a) => {
        const state = sponsorAssetState(a);
        return (
          <article className="card pad stack" key={a.id}>
            <h3>
              {a.name} · {a.required ? "Required" : "Optional"}
            </h3>
            <p>
              {SPONSOR_ASSET_LABELS[state]}
              {a.filename ? ` · ${a.filename}` : ""}
            </p>
            {a.reviewedVersionId === a.versionId && a.reviewNote && (
              <p>Organiser feedback: {a.reviewNote}</p>
            )}
            {a.versionId && a.releasedAt && a.scanStatus === "clean" && (
              <ButtonAnchor
                href={
                  admin
                    ? `/admin/sponsor-assets/${sponsorId}/${a.id}/${a.versionId}`
                    : `/sponsor/${eventId}/${sponsorId}/assets/${a.id}/${a.versionId}`
                }
              >
                Download {a.name}
              </ButtonAnchor>
            )}
            {!admin && (
              <DirectMultipartUpload
                target={{ targetType: "resource", targetId: a.id }}
                endpoint={`/sponsor/${eventId}/${sponsorId}/uploads`}
                heading={`Upload ${a.name}`}
                disabled={closed || busy}
                kinds={[
                  a.kind === "logo"
                    ? {
                        value: "other",
                        label: "Logo",
                        accept: ".jpg,.jpeg,.png,.webp",
                        maximumBytes: filePolicy.headshotMaximumBytes,
                      }
                    : {
                        value: "supporting_document",
                        label: "Supporting document",
                        accept: ".pdf,.doc,.docx,.xls,.xlsx,.zip",
                        maximumBytes: filePolicy.supportingDocumentMaximumBytes,
                      },
                ]}
              />
            )}
            {admin && a.releasedAt && a.scanStatus === "clean" && (
              <Form
                key={`review:${a.versionId}:${a.revision}`}
                method="post"
                className="stack"
              >
                {hidden("review-asset", a)}
                <label className="label">
                  Review outcome
                  <select className="select" name="decision">
                    <option value="approved">Approve this version</option>
                    <option value="changes_requested">Request changes</option>
                  </select>
                </label>
                <label className="label">
                  Feedback
                  <textarea className="textarea" name="note" maxLength={1000} />
                </label>
                <label className="label">
                  <input
                    type="checkbox"
                    name="confirmed"
                    value="yes"
                    required
                  />
                  I have reviewed {a.filename}.
                </label>
                <Button type="submit" disabled={busy}>
                  Save asset review
                </Button>
              </Form>
            )}
            {admin && a.kind === "logo" && state === "approved" && (
              <Form
                key={`stage:${a.versionId}:${commandKey}`}
                method="post"
                className="stack"
              >
                {hidden("stage-logo", a)}
                <p>
                  Review the website details below and select this approved logo
                  for the website draft. Company profile details are prefilled;
                  editing this public copy does not change the company profile.
                  Publish the website separately.
                </p>
                <label className="label">
                  Website sponsor name
                  <input
                    className="field"
                    name="name"
                    defaultValue={companyProfile.name}
                    maxLength={120}
                    aria-describedby={`${a.id}-website-name-help`}
                    required
                  />
                </label>
                <p className="help" id={`${a.id}-website-name-help`}>
                  Use 120 characters or fewer.
                </p>
                <label className="label">
                  Website sponsor tier
                  <input
                    className="field"
                    name="tier"
                    defaultValue={companyProfile.tier}
                    maxLength={80}
                    required
                  />
                </label>
                <label className="label">
                  Website sponsor description
                  <textarea
                    className="textarea"
                    name="description"
                    defaultValue={companyProfile.description}
                    maxLength={1000}
                    aria-describedby={`${a.id}-website-description-help`}
                  />
                </label>
                <p className="help" id={`${a.id}-website-description-help`}>
                  Use 1,000 characters or fewer.
                </p>
                <label className="label">
                  Sponsor website URL
                  <input
                    className="field"
                    name="websiteUrl"
                    type="url"
                    defaultValue={companyProfile.websiteUrl}
                  />
                </label>
                <label className="label">
                  <input
                    type="checkbox"
                    name="confirmed"
                    value="yes"
                    required
                  />
                  Use {a.filename} in the website draft.
                </label>
                <Button type="submit" disabled={busy}>
                  Use logo in website draft
                </Button>
                <ButtonLink to="/admin/site">Review website draft</ButtonLink>
              </Form>
            )}
          </article>
        );
      })}
      {admin && (
        <Form method="post" className="stack">
          {hidden("request-asset")}
          <h3>Request an asset</h3>
          <label className="label">
            Asset name
            <input
              className="field"
              name="assetName"
              maxLength={120}
              required
            />
          </label>
          <label className="label">
            Asset type
            <select className="select" name="kind">
              <option value="logo">Company logo</option>
              <option value="document">Supporting document</option>
            </select>
          </label>
          <label className="label">
            <input type="checkbox" name="required" value="yes" defaultChecked />
            Required for sponsor readiness
          </label>
          <Button type="submit" disabled={busy}>
            Request asset
          </Button>
        </Form>
      )}
    </section>
  );
}
