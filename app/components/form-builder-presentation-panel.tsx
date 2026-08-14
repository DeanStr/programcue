import type { SaveFormInput } from "~/modules/submissions/submission-schema";

export function PresentationSettingsPanel({
  input,
  change,
}: {
  input: SaveFormInput;
  change: (next: SaveFormInput) => void;
}) {
  const presentation = input.schema.presentation;
  const update = (patch: Partial<SaveFormInput["schema"]["presentation"]>) =>
    change({
      ...input,
      schema: {
        ...input.schema,
        presentation: { ...presentation, ...patch },
      },
    });

  return (
    <details className="fb-disclosure">
      <summary>
        <span>
          <strong>Public landing page</strong>
          <small>Invitation, organiser, imagery and programme promotion</small>
        </span>
      </summary>
      <div className="fb-disclosure-fields">
        <p className="help">
          Give applicants enough event context to decide before they start a
          private draft.
        </p>
        <label className="label">
          Invitation heading
          <input
            className="field"
            value={presentation.invitationHeading}
            maxLength={160}
            onChange={(event) =>
              update({ invitationHeading: event.target.value })
            }
            placeholder="What kind of contribution are you inviting?"
          />
        </label>
        <label className="label mt">
          Invitation copy
          <textarea
            className="textarea"
            value={presentation.invitationText}
            maxLength={2_000}
            onChange={(event) => update({ invitationText: event.target.value })}
            placeholder="Explain what the programme team values and what applicants should know."
          />
          <span className="help">
            Leave both invitation fields empty to avoid adding editorial claims
            beyond the event description.
          </span>
        </label>
        <label className="label mt">
          Organiser name
          <input
            className="field"
            value={presentation.organizerName}
            maxLength={120}
            onChange={(event) => update({ organizerName: event.target.value })}
            placeholder="Programme committee or named chair"
          />
        </label>
        <label className="label mt">
          Organiser context
          <input
            className="field"
            value={presentation.organizerRole}
            maxLength={180}
            onChange={(event) => update({ organizerRole: event.target.value })}
            placeholder="Conference chair · Event organisation"
          />
        </label>
        <label className="label mt">
          Event website
          <input
            className="field"
            type="url"
            value={presentation.eventWebsiteUrl}
            maxLength={2_048}
            onChange={(event) =>
              update({ eventWebsiteUrl: event.target.value })
            }
            placeholder="https://…"
          />
        </label>
        <label className="label mt">
          Same-origin hero image path
          <input
            className="field"
            value={presentation.heroImagePath}
            maxLength={300}
            onChange={(event) => update({ heroImagePath: event.target.value })}
            placeholder="/images/event-hero.webp"
          />
          <span className="help">
            Only deployment-owned images below <code>/images/</code> are
            allowed; third-party tracking images remain blocked by the public
            CSP.
          </span>
        </label>
        <label className="label mt">
          Estimated completion time
          <span className="form-row">
            <input
              className="field"
              type="number"
              min={1}
              max={120}
              value={presentation.estimatedMinutes}
              onChange={(event) =>
                update({ estimatedMinutes: Number(event.target.value) })
              }
            />
            <span className="subtle" style={{ alignSelf: "center" }}>
              minutes
            </span>
          </span>
        </label>
        <label className="toggle mt">
          <input
            type="checkbox"
            checked={presentation.showFeaturedSpeakers}
            onChange={(event) =>
              update({ showFeaturedSpeakers: event.target.checked })
            }
          />{" "}
          Show speakers from the published programme
        </label>
        <p className="help">
          The speaker strip appears only when a programme version has been
          published; Program Cue never substitutes unpublished speaker data.
          Programme navigation remains available independently.
        </p>
      </div>
    </details>
  );
}
