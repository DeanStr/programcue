import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import { PersonLookup } from "~/components/person-lookup";
import { Button } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import type { DuplicatePersonMatch } from "~/modules/people/person-duplicate-service.server";
import type { SessionSpeaker } from "~/modules/speakers/session-speaker-service.server";

type SpeakerActionResult =
  | { ok: true; message: string; warning: string | null }
  | {
      ok: false;
      message: string;
      duplicateCheck?: {
        matches: DuplicatePersonMatch[];
        truncated: boolean;
      };
    };

const participation = {
  pending: { label: "Awaiting confirmation", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
} as const;

/** A session's speakers, with adding and removing while the session is
 *  unscheduled or in a draft schedule. Results stay in this panel. */
export function SessionSpeakersPanel({
  speakers,
  lockedReason,
  operationId,
}: {
  speakers: SessionSpeaker[];
  lockedReason: string | null;
  operationId: string;
}) {
  const fetcher = useFetcher<SpeakerActionResult>();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState({ name: "", email: "" });
  const result = fetcher.state === "idle" ? fetcher.data : undefined;
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    setName("");
    setEmail("");
  }, [fetcher.state, fetcher.data]);
  // The identity review applies to the name and email it was shown for.
  const duplicateCheck =
    result && !result.ok && submitted.name === name && submitted.email === email
      ? result.duplicateCheck
      : undefined;
  return (
    <section className="card pad mb" aria-labelledby="session-speakers-title">
      <div className="card-title">
        <div>
          <h2 id="session-speakers-title">Speakers</h2>
        </div>
      </div>
      {result ? (
        <div
          className={`validation-item ${result.ok ? "ok" : "error"} mb`}
          role={result.ok ? "status" : "alert"}
        >
          <span className="pc-validation-item-copy">
            <span>{result.message}</span>
            {result.ok && result.warning ? <span>{result.warning}</span> : null}
          </span>
        </div>
      ) : null}
      <ul className="session-speaker-list">
        {speakers.map((speaker) => {
          const state = participation[speaker.participationStatus];
          return (
            <li key={speaker.personId}>
              <span className="session-speaker-identity">
                <strong>{speaker.name}</strong>
                <small className="subtle">
                  {speaker.email}
                  {speaker.roleLabel ? ` · ${speaker.roleLabel}` : ""}
                </small>
              </span>
              <span className={`status ${state.tone}`}>{state.label}</span>
              {!lockedReason && speakers.length > 1 ? (
                <Button
                  type="button"
                  size="small"
                  disabled={fetcher.state !== "idle"}
                  onClick={() =>
                    confirm(
                      {
                        title: `Remove ${speaker.name} from this session?`,
                        description:
                          "They leave this session and its schedule conflicts. Their onboarding tasks and portal access stay, because tasks belong to the speaker across the event; waive any that no longer apply in Tasks.",
                        records: [
                          `${speaker.name} · ${speaker.email} · ${state.label}`,
                        ],
                        confirmLabel: "Remove speaker",
                      },
                      () =>
                        fetcher.submit(
                          {
                            intent: "remove-speaker",
                            personId: speaker.personId,
                            operationId,
                            confirmed: "true",
                          },
                          { method: "post" },
                        ),
                    )
                  }
                >
                  Remove
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {lockedReason ? (
        <p className="help">{lockedReason}</p>
      ) : (
        <fetcher.Form
          method="post"
          className="stack mt"
          onSubmit={() => setSubmitted({ name, email })}
        >
          <h3>Add a speaker</h3>
          <input type="hidden" name="intent" value="add-speaker" />
          <input type="hidden" name="operationId" value={operationId} />
          <PersonLookup
            purpose="submission-speaker"
            label="Find an existing speaker"
            onSelect={(person) => {
              setName(person.name);
              setEmail(person.email);
            }}
          />
          <div className="form-row">
            <label className="label">
              Speaker name
              <input
                className="field"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="label">
              Speaker email
              <input
                className="field"
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
          </div>
          {duplicateCheck ? (
            <PersonDuplicateWarning
              id="add-session-speaker-duplicate"
              matches={duplicateCheck.matches}
              truncated={duplicateCheck.truncated}
            />
          ) : null}
          <p className="help">
            An added speaker starts awaiting confirmation. Program Cue emails a
            portal invitation to anyone who has not accepted portal access.
          </p>
          <div>
            <Button
              type="submit"
              variant="primary"
              size="small"
              disabled={fetcher.state !== "idle"}
            >
              {fetcher.state !== "idle" &&
              fetcher.formData?.get("intent") === "add-speaker"
                ? "Adding…"
                : "Add speaker"}
            </Button>
          </div>
        </fetcher.Form>
      )}
      {dialog}
    </section>
  );
}
