import { useState } from "react";
import { Button } from "~/components/ui/button";
import type { SponsorSessionDetails } from "~/modules/sponsors/sponsor-schema";

export function SponsorProfileFields({
  value,
}: {
  value?: {
    name: string;
    description: string;
    websiteUrl: string;
    logoUrl: string;
  };
}) {
  return (
    <div className="stack">
      <label className="label">
        Company name
        <input
          className="field"
          name="name"
          defaultValue={value?.name}
          required
          maxLength={160}
        />
      </label>
      <label className="label">
        Company description
        <textarea
          className="textarea"
          name="description"
          defaultValue={value?.description}
          maxLength={3000}
          rows={3}
        />
      </label>
      <label className="label">
        Website URL
        <input
          className="field"
          name="websiteUrl"
          type="url"
          placeholder="https://"
          defaultValue={value?.websiteUrl}
        />
      </label>
      <label className="label">
        Logo URL
        <input
          className="field"
          name="logoUrl"
          type="url"
          placeholder="https://"
          defaultValue={value?.logoUrl}
        />
        <span className="help">
          Use an existing HTTPS image URL. Saving a profile does not publish it
          on the event website.
        </span>
      </label>
    </div>
  );
}

export function SponsorSessionFields({
  value,
  tracks,
  formats,
}: {
  value?: SponsorSessionDetails;
  tracks: Array<{ id: string; name: string }>;
  formats: Array<{ key: string; label: string }>;
}) {
  const [speakers, setSpeakers] = useState(
    (value?.speakers ?? [{ name: "", email: "", biography: "" }]).map(
      (speaker) => ({ ...speaker, key: crypto.randomUUID() }),
    ),
  );
  return (
    <div className="stack">
      <label className="label">
        Session title
        <input
          className="field"
          name="title"
          required
          minLength={3}
          maxLength={180}
          defaultValue={value?.title}
        />
      </label>
      <label className="label">
        Description
        <textarea
          className="textarea"
          name="description"
          maxLength={3000}
          rows={4}
          defaultValue={value?.description}
        />
      </label>
      <label className="label">
        Track
        <select
          className="select"
          name="trackId"
          required
          defaultValue={value?.trackId}
        >
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        Format
        <select
          className="select"
          name="format"
          required
          defaultValue={value?.format}
        >
          {formats.map((format) => (
            <option key={format.key} value={format.key}>
              {format.label}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        Duration in minutes
        <input
          className="field"
          name="durationMinutes"
          type="number"
          min={5}
          max={480}
          defaultValue={value?.durationMinutes}
        />
        <span className="help">
          Leave blank to use the event’s default for this format.
        </span>
      </label>
      {speakers.map((speaker, index) => (
        <fieldset className="card pad" key={speaker.key}>
          <legend>Speaker {index + 1}</legend>
          <label className="label">
            Speaker name
            <input
              className="field"
              name="speakerName"
              required
              maxLength={120}
              value={speaker.name}
              onChange={(event) =>
                setSpeakers(
                  speakers.map((item) =>
                    item.key === speaker.key
                      ? { ...item, name: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label className="label">
            Speaker email
            <input
              className="field"
              name="speakerEmail"
              type="email"
              required
              maxLength={254}
              value={speaker.email}
              onChange={(event) =>
                setSpeakers(
                  speakers.map((item) =>
                    item.key === speaker.key
                      ? { ...item, email: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label className="label">
            Biography
            <textarea
              className="textarea"
              name="speakerBiography"
              maxLength={5000}
              value={speaker.biography}
              onChange={(event) =>
                setSpeakers(
                  speakers.map((item) =>
                    item.key === speaker.key
                      ? { ...item, biography: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
        </fieldset>
      ))}
      <div className="page-actions">
        <Button
          type="button"
          disabled={speakers.length >= 20}
          onClick={() =>
            setSpeakers([
              ...speakers,
              { key: crypto.randomUUID(), name: "", email: "", biography: "" },
            ])
          }
        >
          Add co-speaker
        </Button>
        {speakers.length > 1 && (
          <Button
            type="button"
            onClick={() => setSpeakers(speakers.slice(0, -1))}
          >
            Remove last co-speaker
          </Button>
        )}
      </div>
    </div>
  );
}
