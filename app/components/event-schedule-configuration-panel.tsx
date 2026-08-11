import { useState, type Dispatch, type SetStateAction } from "react";

import type { EventSetup } from "~/modules/events/event-repository.server";
import type { ActionResponse } from "~/routes/event-setup";

type Tracks = EventSetup["tracks"];
type SessionFormats = EventSetup["sessionFormats"];

function configurationKey(label: string, fallbackPrefix: string) {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return key || `${fallbackPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function FieldError({
  actionData,
  name,
}: {
  actionData?: ActionResponse;
  name: string;
}) {
  const message = actionData?.errors?.[name]?.[0];
  return message ? (
    <p className="help" style={{ color: "var(--red)" }}>
      {message}
    </p>
  ) : null;
}

export function EventScheduleConfigurationPanels({
  tracks,
  setTracks,
  sessionFormats,
  setSessionFormats,
  actionData,
}: {
  tracks: Tracks;
  setTracks: Dispatch<SetStateAction<Tracks>>;
  sessionFormats: SessionFormats;
  setSessionFormats: Dispatch<SetStateAction<SessionFormats>>;
  actionData?: ActionResponse;
}) {
  const [newTrackName, setNewTrackName] = useState("");
  const [newFormatLabel, setNewFormatLabel] = useState("");

  function addTrack() {
    const name = newTrackName.trim();
    if (!name) return;
    const requestedSlug = configurationKey(name, "track");
    const slug = tracks.some((track) => track.slug === requestedSlug)
      ? `${requestedSlug}-${crypto.randomUUID().slice(0, 8)}`
      : requestedSlug;
    setTracks((current) => [
      ...current,
      {
        id: `track-${crypto.randomUUID()}`,
        name,
        slug,
        colourToken: null,
        position: current.length,
        exclusive: false,
        isPublic: true,
      },
    ]);
    setNewTrackName("");
  }

  function addFormat() {
    const label = newFormatLabel.trim();
    if (!label) return;
    const requestedKey = configurationKey(label, "format");
    const key = sessionFormats.some((format) => format.key === requestedKey)
      ? `${requestedKey}-${crypto.randomUUID().slice(0, 8)}`
      : requestedKey;
    setSessionFormats((current) => [
      ...current,
      {
        key,
        label,
        defaultDurationMinutes: 45,
        position: current.length,
      },
    ]);
    setNewFormatLabel("");
  }

  return (
    <>
      <section className="card pad">
        <div className="card-title">
          <div>
            <h2>Programme tracks</h2>
            <p className="subtle">
              Exclusive tracks cannot overlap when that schedule policy is
              enabled.
            </p>
          </div>
        </div>
        <div className="stack">
          {tracks.map((track) => (
            <div className="card pad" key={track.id}>
              <div className="form-row">
                <label className="label">
                  Track name
                  <input
                    className="field"
                    value={track.name}
                    maxLength={120}
                    onChange={(changeEvent) =>
                      setTracks((current) =>
                        current.map((candidate) =>
                          candidate.id === track.id
                            ? { ...candidate, name: changeEvent.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                </label>
                <label className="label">
                  Track key
                  <input className="field" value={track.slug} readOnly />
                  <span className="help">Stable after creation.</span>
                </label>
                <label className="label">
                  Colour
                  <input
                    className="field"
                    type="color"
                    aria-label={`${track.name} colour`}
                    value={track.colourToken ?? "#5e6ad2"}
                    onChange={(changeEvent) =>
                      setTracks((current) =>
                        current.map((candidate) =>
                          candidate.id === track.id
                            ? {
                                ...candidate,
                                colourToken: changeEvent.target.value,
                              }
                            : candidate,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              <div className="row-main mt" style={{ flexWrap: "wrap" }}>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={track.exclusive}
                    onChange={(changeEvent) =>
                      setTracks((current) =>
                        current.map((candidate) =>
                          candidate.id === track.id
                            ? {
                                ...candidate,
                                exclusive: changeEvent.target.checked,
                              }
                            : candidate,
                        ),
                      )
                    }
                  />{" "}
                  Exclusive
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={track.isPublic}
                    onChange={(changeEvent) =>
                      setTracks((current) =>
                        current.map((candidate) =>
                          candidate.id === track.id
                            ? {
                                ...candidate,
                                isPublic: changeEvent.target.checked,
                              }
                            : candidate,
                        ),
                      )
                    }
                  />{" "}
                  Public
                </label>
                <button
                  type="button"
                  className="btn small right"
                  onClick={() =>
                    setTracks((current) =>
                      current.filter((candidate) => candidate.id !== track.id),
                    )
                  }
                  aria-label={`Remove ${track.name}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {!tracks.length ? (
            <p className="subtle">No tracks configured.</p>
          ) : null}
          <div className="row-main" style={{ alignItems: "end" }}>
            <label className="label" style={{ flex: 1 }}>
              New track
              <input
                className="field"
                value={newTrackName}
                placeholder="Leadership"
                onChange={(changeEvent) =>
                  setNewTrackName(changeEvent.target.value)
                }
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.key !== "Enter") return;
                  keyboardEvent.preventDefault();
                  addTrack();
                }}
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={addTrack}
              disabled={!newTrackName.trim()}
            >
              Add track
            </button>
          </div>
        </div>
        <FieldError actionData={actionData} name="tracks" />
      </section>

      <section className="card pad">
        <div className="card-title">
          <div>
            <h2>Session formats and durations</h2>
            <p className="subtle">
              Defaults are used when a new session is created; schedulers can
              still set an explicit duration.
            </p>
          </div>
        </div>
        <div className="stack">
          {sessionFormats.map((format) => (
            <div className="form-row" key={format.key}>
              <label className="label">
                Format label
                <input
                  className="field"
                  value={format.label}
                  maxLength={80}
                  onChange={(changeEvent) =>
                    setSessionFormats((current) =>
                      current.map((candidate) =>
                        candidate.key === format.key
                          ? { ...candidate, label: changeEvent.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
              </label>
              <label className="label">
                Format key
                <input
                  className="field"
                  value={format.key}
                  readOnly
                  aria-describedby={`format-key-help-${format.key}`}
                />
                <span className="help" id={`format-key-help-${format.key}`}>
                  Stable after creation.
                </span>
              </label>
              <label className="label">
                Default minutes
                <input
                  className="field"
                  type="number"
                  min={5}
                  max={480}
                  step={5}
                  value={format.defaultDurationMinutes}
                  onChange={(changeEvent) =>
                    setSessionFormats((current) =>
                      current.map((candidate) =>
                        candidate.key === format.key
                          ? {
                              ...candidate,
                              defaultDurationMinutes: Number(
                                changeEvent.target.value,
                              ),
                            }
                          : candidate,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${format.label}`}
                disabled={sessionFormats.length === 1}
                onClick={() =>
                  setSessionFormats((current) =>
                    current.filter((candidate) => candidate.key !== format.key),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <div className="row-main" style={{ alignItems: "end" }}>
            <label className="label" style={{ flex: 1 }}>
              New format
              <input
                className="field"
                value={newFormatLabel}
                placeholder="Roundtable"
                onChange={(changeEvent) =>
                  setNewFormatLabel(changeEvent.target.value)
                }
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.key !== "Enter") return;
                  keyboardEvent.preventDefault();
                  addFormat();
                }}
              />
            </label>
            <button
              type="button"
              className="btn"
              onClick={addFormat}
              disabled={!newFormatLabel.trim()}
            >
              Add format
            </button>
          </div>
        </div>
        <FieldError actionData={actionData} name="sessionFormats" />
      </section>
    </>
  );
}
