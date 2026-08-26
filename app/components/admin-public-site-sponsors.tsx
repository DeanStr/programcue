import { Plus } from "lucide-react";
import { useMemo } from "react";
import { Form } from "react-router";

import {
  SitePanelHeading,
  SiteRecordDisclosure,
} from "~/components/admin-public-site-panels";
import { Button } from "~/components/ui/button";
import type { PublicSiteSponsor } from "~/modules/public-site/public-site";

function SponsorFields({ sponsor }: { sponsor?: PublicSiteSponsor }) {
  return (
    <div className="public-site-field-grid">
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
      <label className="label is-wide">
        Description
        <textarea
          className="textarea"
          name="description"
          defaultValue={sponsor?.description ?? ""}
          maxLength={1000}
          rows={2}
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
    </div>
  );
}

export function AdminPublicSiteSponsors({
  sponsors,
  draftCreated,
  blockedReason,
  busy,
  hidden,
  onDelete,
}: {
  sponsors: PublicSiteSponsor[];
  draftCreated: boolean;
  /* Why these controls are unavailable, or null when they are not. One value,
     because the notice and the disabled state must never disagree. */
  blockedReason: string | null;
  busy: boolean;
  hidden: boolean;
  onDelete: (sponsor: PublicSiteSponsor) => void;
}) {
  const commandIds = useMemo(() => {
    const ids = new Map(
      sponsors.map((sponsor) => [sponsor.id, crypto.randomUUID()] as const),
    );
    ids.set("", crypto.randomUUID());
    return ids;
  }, [sponsors]);
  const blocked = blockedReason !== null;
  return (
    <section
      className="public-site-editor-panel"
      aria-label="Sponsors"
      hidden={hidden}
    >
      <SitePanelHeading
        title="Sponsors"
        help="Sponsor records are snapshotted onto the public site only when the site is published."
      />
      {blockedReason ? (
        <p className="validation-item warn" role="status">
          {blockedReason}
        </p>
      ) : null}
      {sponsors.length ? (
        <div className="public-site-record-list">
          {sponsors.map((sponsor) => (
            <SiteRecordDisclosure
              key={sponsor.id}
              title={sponsor.name}
              meta={sponsor.tier}
              state={`Order ${sponsor.position}`}
            >
              <Form method="post" className="public-site-record-editor">
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
                  <Button size="small" type="submit" disabled={blocked || busy}>
                    Save sponsor
                  </Button>
                  <Button
                    variant="danger"
                    size="small"
                    type="button"
                    disabled={blocked || busy}
                    onClick={() => onDelete(sponsor)}
                  >
                    Remove
                  </Button>
                </div>
              </Form>
            </SiteRecordDisclosure>
          ))}
        </div>
      ) : (
        <p className="help">No sponsors in this draft yet.</p>
      )}
      <Form method="post" className="public-site-record-editor is-new">
        <input type="hidden" name="intent" value="save-sponsor" />
        <input type="hidden" name="commandId" value={commandIds.get("")} />
        <input type="hidden" name="id" value="" />
        <input type="hidden" name="revision" value="0" />
        <h3 className="public-site-panel-title">Add a sponsor</h3>
        <SponsorFields />
        <div className="page-actions">
          <Button
            size="small"
            type="submit"
            disabled={!draftCreated || blocked || busy}
          >
            <Plus aria-hidden size={14} /> Add sponsor
          </Button>
        </div>
        {draftCreated ? null : (
          <p className="help">
            Save the website draft before adding sponsor records.
          </p>
        )}
      </Form>
    </section>
  );
}
