import { X } from "lucide-react";
import { useState, type Dispatch, type SetStateAction } from "react";

import {
  RecordChevron,
  RecordField,
  RecordHead,
} from "~/components/event-record-row";
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
  return message ? <p className="pc-field-error">{message}</p> : null;
}

export function EventScheduleConfigurationPanels({
  tracks,
  setTracks,
  sessionFormats,
  setSessionFormats,
  actionData,
  onRemove,
  focusedTrackId,
  onDraftStateChange,
}: {
  tracks: Tracks;
  setTracks: Dispatch<SetStateAction<Tracks>>;
  sessionFormats: SessionFormats;
  setSessionFormats: Dispatch<SetStateAction<SessionFormats>>;
  actionData?: ActionResponse;
  onRemove: (trackId: string) => void;
  focusedTrackId: string | null;
  onDraftStateChange: (draftKey: string, value: string) => void;
}) {
  const [newTrackName, setNewTrackName] = useState("");
  const [newFormatLabel, setNewFormatLabel] = useState("");

  function updateTrackDraft(value: string) {
    setNewTrackName(value);
    onDraftStateChange("track", value);
  }

  function updateFormatDraft(value: string) {
    setNewFormatLabel(value);
    onDraftStateChange("format", value);
  }

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
    onDraftStateChange("track", "");
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
    onDraftStateChange("format", "");
  }

  return (
    <>
      <details
        className="card pad event-record-panel"
        // A deep link from Event Setup focuses a track by id, which cannot
        // happen inside a closed panel.
        open={
          focusedTrackId !== null || Boolean(actionData?.errors?.tracks?.length)
        }
      >
        <summary>
          <RecordChevron />
          <div className="event-record-summary">
            <h3>Programme tracks</h3>
            {tracks.length ? (
              <div className="event-record-preview">
                {tracks.slice(0, 4).map((track) => (
                  <span className="event-record-chip" key={track.id}>
                    {/* The dot is the track's own colour, which is the thing a
                        scheduler checks for a clash. The name carries the
                        meaning, so a repainted or unseen dot loses nothing. */}
                    <span
                      className="event-record-chip-dot"
                      style={{ background: track.colourToken ?? "#5e6ad2" }}
                    />
                    {track.name}
                  </span>
                ))}
                {tracks.length > 4 ? (
                  <span className="event-record-chip">
                    +{tracks.length - 4} more
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <span className="event-record-count">
            {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
          </span>
        </summary>
        <div className="event-record-body">
          <div className="event-record-intro">
            <p className="help">
              Exclusive tracks cannot overlap when that schedule policy is
              enabled. Track keys are stable after creation.
            </p>
          </div>
          {tracks.length ? (
            <div>
              <RecordHead
                columns="event-track-columns"
                // The two toggles carry their own visible text, so that column
                // needs no caption. "Visibility" was wrong for Exclusive, which
                // is a scheduling constraint rather than an audience.
                captions={["Track name", "Track key", "Colour", "", ""]}
              />
              <div className="event-record-list">
                {tracks.map((track) => (
                  <div
                    className={`event-record-row event-track-columns${focusedTrackId === track.id ? " selected" : ""}`}
                    id={`event-track-${track.id}`}
                    key={track.id}
                    tabIndex={-1}
                    role="group"
                    aria-label={`${track.name} track settings`}
                  >
                    <RecordField
                      caption="Track name"
                      accessibleCaption={`${track.name} track name`}
                    >
                      <input
                        className="field"
                        value={track.name}
                        maxLength={120}
                        onChange={(changeEvent) =>
                          setTracks((current) =>
                            current.map((candidate) =>
                              candidate.id === track.id
                                ? {
                                    ...candidate,
                                    name: changeEvent.target.value,
                                  }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </RecordField>
                    <RecordField
                      caption="Track key"
                      accessibleCaption={`${track.name} track key`}
                    >
                      <input className="field" value={track.slug} readOnly />
                    </RecordField>
                    <RecordField
                      caption="Colour"
                      accessibleCaption={`${track.name} colour`}
                    >
                      <input
                        className="field"
                        type="color"
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
                    </RecordField>
                    <div className="event-record-toggles">
                      <label className="toggle">
                        <input
                          type="checkbox"
                          aria-label={`${track.name} exclusive`}
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
                          aria-label={`${track.name} public`}
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
                    </div>
                    <div className="event-record-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => {
                          setTracks((current) =>
                            current.filter(
                              (candidate) => candidate.id !== track.id,
                            ),
                          );
                          onRemove(track.id);
                        }}
                        aria-label={`Remove ${track.name}`}
                      >
                        <X aria-hidden size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="subtle">No tracks configured.</p>
          )}
          <div className="event-record-add">
            <label className="label">
              New track
              <input
                className="field"
                value={newTrackName}
                data-event-record-draft="track"
                placeholder="Leadership"
                onChange={(changeEvent) =>
                  updateTrackDraft(changeEvent.target.value)
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
          <FieldError actionData={actionData} name="tracks" />
        </div>
      </details>

      <details
        className="card pad event-record-panel"
        open={Boolean(actionData?.errors?.sessionFormats?.length)}
      >
        <summary>
          <RecordChevron />
          <div className="event-record-summary">
            <h3>Session formats and durations</h3>
            {sessionFormats.length ? (
              <div className="event-record-preview">
                {sessionFormats.slice(0, 4).map((format) => (
                  <span className="event-record-chip" key={format.key}>
                    {format.label} ·{" "}
                    <span className="pc-num">
                      {format.defaultDurationMinutes}
                    </span>{" "}
                    min
                  </span>
                ))}
                {sessionFormats.length > 4 ? (
                  <span className="event-record-chip">
                    +{sessionFormats.length - 4} more
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <span className="event-record-count">
            {sessionFormats.length}{" "}
            {sessionFormats.length === 1 ? "format" : "formats"}
          </span>
        </summary>
        <div className="event-record-body">
          <div className="event-record-intro">
            <p className="help">
              Defaults are used when a new session is created; schedulers can
              still set an explicit duration. Format keys are stable after
              creation.
            </p>
          </div>
          <div>
            <RecordHead
              columns="event-format-columns"
              captions={["Format label", "Format key", "Default minutes", ""]}
            />
            <div className="event-record-list">
              {sessionFormats.map((format) => (
                <div
                  className="event-record-row event-format-columns"
                  key={format.key}
                  role="group"
                  aria-label={`${format.label} format settings`}
                >
                  <RecordField
                    caption="Format label"
                    accessibleCaption={`${format.label} format label`}
                  >
                    <input
                      className="field"
                      value={format.label}
                      maxLength={80}
                      onChange={(changeEvent) =>
                        setSessionFormats((current) =>
                          current.map((candidate) =>
                            candidate.key === format.key
                              ? {
                                  ...candidate,
                                  label: changeEvent.target.value,
                                }
                              : candidate,
                          ),
                        )
                      }
                    />
                  </RecordField>
                  <RecordField
                    caption="Format key"
                    accessibleCaption={`${format.label} format key`}
                  >
                    <input className="field" value={format.key} readOnly />
                  </RecordField>
                  <RecordField
                    caption="Default minutes"
                    accessibleCaption={`${format.label} default minutes`}
                  >
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
                  </RecordField>
                  <div className="event-record-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${format.label}`}
                      disabled={sessionFormats.length === 1}
                      onClick={() =>
                        setSessionFormats((current) =>
                          current.filter(
                            (candidate) => candidate.key !== format.key,
                          ),
                        )
                      }
                    >
                      <X aria-hidden size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="event-record-add">
            <label className="label">
              New format
              <input
                className="field"
                value={newFormatLabel}
                data-event-record-draft="format"
                placeholder="Roundtable"
                onChange={(changeEvent) =>
                  updateFormatDraft(changeEvent.target.value)
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
          <FieldError actionData={actionData} name="sessionFormats" />
        </div>
      </details>
    </>
  );
}
