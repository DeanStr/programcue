import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { CharacterCount } from "~/components/ui/character-count";
import type { SaveFormInput } from "~/modules/submissions/submission-schema";

function suggestedCompletionMinutes(input: SaveFormInput) {
  const fieldMinutes = input.schema.fields.reduce((total, field) => {
    if (field.type === "long_text") return total + 3;
    if (field.type === "video") return total + 5;
    return total + 1;
  }, 2);
  return Math.min(120, Math.max(1, fieldMinutes));
}

export function PresentationSettingsPanel({
  input,
  change,
  errors,
}: {
  input: SaveFormInput;
  change: (next: SaveFormInput) => void;
  errors?: Record<string, string[]>;
}) {
  const presentation = input.schema.presentation;
  const suggestedMinutes = suggestedCompletionMinutes(input);
  const presentationHasErrors = Boolean(
    errors &&
      Object.keys(errors).some((key) => key.startsWith("schema.presentation")),
  );
  const [landingOpen, setLandingOpen] = useState(presentationHasErrors);
  useEffect(() => {
    if (presentationHasErrors) setLandingOpen(true);
  }, [presentationHasErrors]);
  const update = (patch: Partial<SaveFormInput["schema"]["presentation"]>) =>
    change({
      ...input,
      schema: {
        ...input.schema,
        presentation: { ...presentation, ...patch },
      },
    });

  return (
    <details
      className="fb-disclosure"
      open={landingOpen || presentationHasErrors}
      onToggle={(event) => {
        if (presentationHasErrors) {
          setLandingOpen(true);
          return;
        }
        setLandingOpen(event.currentTarget.open);
      }}
    >
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
          <CharacterCount value={presentation.invitationText} maximum={2_000} />
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
            id="form-builder-event-website"
            aria-invalid={Boolean(
              errors?.["schema.presentation.eventWebsiteUrl"]?.length,
            )}
          />
          {errors?.["schema.presentation.eventWebsiteUrl"]?.[0] ? (
            <span className="pc-field-error">
              {errors["schema.presentation.eventWebsiteUrl"][0]}
            </span>
          ) : null}
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
        {presentation.estimatedMinutes !== suggestedMinutes ? (
          <p className="help">
            Based on the current question types, Program Cue suggests about{" "}
            {suggestedMinutes} minutes.{" "}
            <Button
              size="small"
              type="button"
              onClick={() => update({ estimatedMinutes: suggestedMinutes })}
            >
              Use {suggestedMinutes} minutes
            </Button>
          </p>
        ) : (
          <p className="help">
            Matches the estimate from the current questions.
          </p>
        )}
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
