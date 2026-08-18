import { useMemo } from "react";
import { Form } from "react-router";

import type { PublicSiteSponsor } from "~/modules/public-site/public-site";

function SponsorFields({ sponsor }: { sponsor?: PublicSiteSponsor }) {
  return (
    <>
      <label className="label">
        {sponsor ? "Name" : "New sponsor name"}
        <input
          className="field"
          name="name"
          defaultValue={sponsor?.name}
          required
          maxLength={120}
        />
      </label>
      <label className="label">
        Tier
        <input
          className="field"
          name="tier"
          defaultValue={sponsor?.tier}
          required
          maxLength={80}
        />
      </label>
      <label className="label">
        Website URL
        <input
          className="field"
          name="websiteUrl"
          type="url"
          defaultValue={sponsor?.websiteUrl ?? ""}
        />
      </label>
      <label className="label">
        Logo URL
        <input
          className="field"
          name="logoUrl"
          type="url"
          defaultValue={sponsor?.logoUrl ?? ""}
        />
      </label>
      <label className="label">
        Description
        <textarea
          className="textarea"
          name="description"
          defaultValue={sponsor?.description ?? ""}
          maxLength={1000}
        />
      </label>
      <label className="label">
        Order
        <input
          className="field"
          name="position"
          type="number"
          min={0}
          max={1000}
          defaultValue={sponsor?.position ?? 0}
        />
      </label>
    </>
  );
}

export function AdminPublicSiteSponsors({
  sponsors,
  draftCreated,
  blocked,
  busy,
  onDelete,
}: {
  sponsors: PublicSiteSponsor[];
  draftCreated: boolean;
  blocked: boolean;
  busy: boolean;
  onDelete: (sponsor: PublicSiteSponsor) => void;
}) {
  const commandIds = useMemo(() => {
    const ids = new Map(
      sponsors.map((sponsor) => [sponsor.id, crypto.randomUUID()] as const),
    );
    ids.set("", crypto.randomUUID());
    return ids;
  }, [sponsors]);
  return (
    <section className="public-site-rail-section">
      <div className="card-title">
        <div>
          <h2 className="public-site-rail-title">Sponsors</h2>
          <p className="help">
            Structured records are snapshotted only when the site is published.
          </p>
        </div>
      </div>
      {sponsors.map((sponsor) => (
        <Form
          method="post"
          className="public-site-record-editor"
          key={sponsor.id}
        >
          <input type="hidden" name="intent" value="save-sponsor" />
          <input
            type="hidden"
            name="commandId"
            value={commandIds.get(sponsor.id)}
          />
          <input type="hidden" name="id" value={sponsor.id} />
          <input type="hidden" name="revision" value={sponsor.revision} />
          <SponsorFields sponsor={sponsor} />
          <div className="page-actions">
            <button
              className="btn small"
              type="submit"
              disabled={blocked || busy}
            >
              Save sponsor
            </button>
            <button
              className="btn small danger"
              type="button"
              disabled={blocked || busy}
              onClick={() => onDelete(sponsor)}
            >
              Remove
            </button>
          </div>
        </Form>
      ))}
      <Form method="post" className="public-site-record-editor">
        <input type="hidden" name="intent" value="save-sponsor" />
        <input type="hidden" name="commandId" value={commandIds.get("")} />
        <input type="hidden" name="id" value="" />
        <input type="hidden" name="revision" value="0" />
        <SponsorFields />
        <button
          className="btn small"
          type="submit"
          disabled={!draftCreated || blocked || busy}
        >
          Add sponsor
        </button>
      </Form>
    </section>
  );
}
