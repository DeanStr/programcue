import { Check, Clipboard, ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";

import {
  defaultProgrammeEmbedConfiguration,
  PROGRAMME_EMBED_CONTROLS,
  PROGRAMME_EMBED_FIELDS,
  PROGRAMME_EMBED_SURFACES,
  parseProgrammeEmbedHeight,
  ProgrammeEmbedConfigurationError,
  programmeEmbedFilterOptions,
  programmeEmbedUrl,
  programmeIframeSnippet,
  programmeWidgetSnippet,
  type ProgrammeEmbedConfiguration,
  type ProgrammeEmbedControl,
  type ProgrammeEmbedField,
  type ProgrammeEmbedSurface,
} from "~/modules/programme/programme-embed-configuration";

type EmbedSession = {
  startsAt: number | null;
  status: string;
  track: string | null;
  format: string;
  room: string | null;
  visibility: string;
};

const controlLabels: Record<ProgrammeEmbedControl, string> = {
  search: "Search",
  day: "Day",
  track: "Track",
  format: "Format",
  room: "Room",
};

const surfaceLabels: Record<ProgrammeEmbedSurface, string> = {
  sessions: "Programme / session list",
  speakers: "Speakers list",
  agenda: "Agenda",
  schedule: "Schedule itinerary",
  gallery: "Speaker gallery",
};

const fieldLabels: Record<ProgrammeEmbedField, string> = {
  time: "Time and duration",
  location: "Room and location",
  track: "Track",
  format: "Format",
  description: "Descriptions",
  "speaker-details": "Speaker detail blocks and profile links",
  affiliations: "Job title and company",
  images: "Speaker photos",
  biography: "Biographies and pronunciation",
  sessions: "Linked sessions and counts",
};

export function ProgrammeEmbedBuilder({
  publicOrigin,
  publicSlug,
  eventName,
  eventAccent,
  timezone,
  sessions,
}: {
  publicOrigin: string;
  publicSlug: string;
  eventName: string;
  eventAccent: string;
  timezone: string;
  sessions: EmbedSession[];
}) {
  const [configuration, setConfiguration] =
    useState<ProgrammeEmbedConfiguration>(defaultProgrammeEmbedConfiguration);
  const [heightInput, setHeightInput] = useState(
    String(defaultProgrammeEmbedConfiguration().height),
  );
  const [output, setOutput] = useState<"iframe" | "widget">("iframe");
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">(
    "desktop",
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const { days, tracks, formats, rooms } = programmeEmbedFilterOptions(
    sessions,
    timezone,
  );
  const previewUrl = programmeEmbedUrl(publicOrigin, publicSlug, configuration);
  const target = `programcue-${publicSlug}-${configuration.surface}`;
  const title = `${eventName} ${surfaceLabels[configuration.surface]}`;
  let parsedHeight: number | null = null;
  let heightError: string | null = null;
  try {
    parsedHeight = parseProgrammeEmbedHeight(heightInput);
  } catch (error) {
    if (error instanceof ProgrammeEmbedConfigurationError) {
      heightError = error.message;
    } else {
      throw error;
    }
  }
  const outputConfiguration =
    parsedHeight === null ? null : { ...configuration, height: parsedHeight };
  const code =
    outputConfiguration === null
      ? ""
      : output === "iframe"
        ? programmeIframeSnippet(previewUrl, title, outputConfiguration.height)
        : programmeWidgetSnippet({
            origin: publicOrigin,
            eventSlug: publicSlug,
            target,
            title,
            configuration: outputConfiguration,
          });

  function update<Key extends keyof ProgrammeEmbedConfiguration>(
    key: Key,
    value: ProgrammeEmbedConfiguration[Key],
  ) {
    setConfiguration((current) => ({ ...current, [key]: value }));
    setCopyState("idle");
  }

  function toggleControl(control: ProgrammeEmbedControl) {
    update(
      "controls",
      configuration.controls.includes(control)
        ? configuration.controls.filter((value) => value !== control)
        : PROGRAMME_EMBED_CONTROLS.filter(
            (value) =>
              value === control || configuration.controls.includes(value),
          ),
    );
  }

  function toggleField(field: ProgrammeEmbedField) {
    update(
      "fields",
      configuration.fields.includes(field)
        ? configuration.fields.filter((value) => value !== field)
        : PROGRAMME_EMBED_FIELDS.filter(
            (value) => value === field || configuration.fields.includes(value),
          ),
    );
  }

  async function copyCode() {
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function reset() {
    const defaults = defaultProgrammeEmbedConfiguration();
    setConfiguration(defaults);
    setHeightInput(String(defaults.height));
    setOutput("iframe");
    setPreviewWidth("desktop");
    setCopyState("idle");
  }

  return (
    <section className="card pad mt programme-embed-builder">
      <div className="card-title programme-embed-builder-title">
        <div>
          <span className="pc-page-eyebrow">Published programme</span>
          <h2>Configure embed</h2>
          <p className="help">
            Choose the initial view, preview the exact published result and copy
            installation code without editing HTML attributes by hand.
          </p>
        </div>
        <button className="btn small" type="button" onClick={reset}>
          <RotateCcw aria-hidden size={14} /> Reset
        </button>
      </div>

      <div className="programme-embed-builder-layout">
        <div className="programme-embed-configuration">
          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Widget type</legend>
            <p className="help">
              Each option renders its corresponding published public surface.
            </p>
            <label className="label">
              Public surface
              <select
                className="select"
                value={configuration.surface}
                onChange={(event) =>
                  update("surface", event.target.value as ProgrammeEmbedSurface)
                }
              >
                {PROGRAMME_EMBED_SURFACES.map((surface) => (
                  <option key={surface} value={surface}>
                    {surfaceLabels[surface]}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Initial filters</legend>
            <p className="help">
              These values constrain the first rendered view. Only published
              schedule values can be selected.
            </p>
            <label className="label">
              Day
              <select
                className="select"
                aria-label="Initial day"
                value={configuration.day}
                onChange={(event) => update("day", event.target.value)}
              >
                <option value="">All days</option>
                {days.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Track
              <select
                className="select"
                aria-label="Initial track"
                value={configuration.track}
                onChange={(event) => update("track", event.target.value)}
              >
                <option value="">All tracks</option>
                {tracks.map((track) => (
                  <option key={track} value={track}>
                    {track}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Format
              <select
                className="select"
                aria-label="Initial format"
                value={configuration.format}
                onChange={(event) => update("format", event.target.value)}
              >
                <option value="">All formats</option>
                {formats.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Room
              <select
                className="select"
                aria-label="Initial room"
                value={configuration.room}
                onChange={(event) => update("room", event.target.value)}
              >
                <option value="">All rooms</option>
                {rooms.map((room) => (
                  <option key={room} value={room}>
                    {room}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Search text
              <input
                className="field"
                value={configuration.query}
                maxLength={100}
                onChange={(event) => update("query", event.target.value)}
                placeholder="Optional published-content search"
              />
            </label>
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Visible visitor controls</legend>
            <p className="help">
              Hidden controls keep their configured initial value fixed in the
              installed embed.
            </p>
            <div className="programme-embed-control-grid">
              {PROGRAMME_EMBED_CONTROLS.map((control) => (
                <label className="choice" key={control}>
                  <input
                    type="checkbox"
                    checked={configuration.controls.includes(control)}
                    onChange={() => toggleControl(control)}
                  />
                  {controlLabels[control]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Appearance and content</legend>
            <div className="programme-embed-appearance-grid">
              <label className="label">
                Accent
                <input
                  className="field programme-embed-colour"
                  type="color"
                  value={configuration.accent || eventAccent}
                  onChange={(event) => update("accent", event.target.value)}
                />
              </label>
              <label className="label">
                Density
                <select
                  className="select"
                  value={configuration.density}
                  onChange={(event) =>
                    update(
                      "density",
                      event.target
                        .value as ProgrammeEmbedConfiguration["density"],
                    )
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label className="label">
                Initial height
                <input
                  className="field"
                  type="number"
                  min={160}
                  max={20_000}
                  step={10}
                  value={heightInput}
                  aria-invalid={heightError ? true : undefined}
                  aria-describedby={
                    heightError ? "programme-embed-height-error" : undefined
                  }
                  onChange={(event) => {
                    setHeightInput(event.target.value);
                    setCopyState("idle");
                  }}
                />
                {heightError ? (
                  <span
                    className="validation-item error"
                    id="programme-embed-height-error"
                    role="alert"
                  >
                    {heightError}
                  </span>
                ) : null}
              </label>
            </div>
            {configuration.surface === "sessions" ? (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={configuration.showSpeakerDirectory}
                  onChange={(event) =>
                    update("showSpeakerDirectory", event.target.checked)
                  }
                />
                Include the speaker directory
              </label>
            ) : null}
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Visible fields</legend>
            <p className="help">
              Session titles and speaker names remain visible. Choose which
              supporting published details appear where they apply.
            </p>
            <div className="programme-embed-control-grid">
              {PROGRAMME_EMBED_FIELDS.map((field) => (
                <label className="choice" key={field}>
                  <input
                    type="checkbox"
                    checked={configuration.fields.includes(field)}
                    onChange={() => toggleField(field)}
                  />
                  {fieldLabels[field]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="programme-embed-output">
          <div className="card-title">
            <div>
              <h3>Live preview</h3>
              <p className="help">The iframe uses the exact generated URL.</p>
            </div>
            <div className="segmented" role="group" aria-label="Preview width">
              <button
                type="button"
                className={`btn small${previewWidth === "desktop" ? " active" : ""}`}
                aria-pressed={previewWidth === "desktop"}
                onClick={() => setPreviewWidth("desktop")}
              >
                Desktop
              </button>
              <button
                type="button"
                className={`btn small${previewWidth === "mobile" ? " active" : ""}`}
                aria-pressed={previewWidth === "mobile"}
                onClick={() => setPreviewWidth("mobile")}
              >
                Mobile
              </button>
            </div>
          </div>
          <div
            className={`programme-embed-preview ${previewWidth}`}
            data-preview-width={previewWidth}
          >
            <iframe
              key={previewUrl}
              src={previewUrl}
              title={`${eventName} embed preview`}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>

          <div className="programme-embed-install">
            <div className="card-title">
              <div>
                <h3>Install</h3>
                <p className="help">
                  The script widget adds safe automatic height updates.
                </p>
              </div>
              <div
                className="segmented"
                role="group"
                aria-label="Installation type"
              >
                <button
                  type="button"
                  className={`btn small${output === "iframe" ? " active" : ""}`}
                  aria-pressed={output === "iframe"}
                  onClick={() => {
                    setOutput("iframe");
                    setCopyState("idle");
                  }}
                >
                  Iframe
                </button>
                <button
                  type="button"
                  className={`btn small${output === "widget" ? " active" : ""}`}
                  aria-pressed={output === "widget"}
                  onClick={() => {
                    setOutput("widget");
                    setCopyState("idle");
                  }}
                >
                  Widget
                </button>
              </div>
            </div>
            <label className="label">
              {output === "iframe"
                ? "Iframe code"
                : "Auto-resizing widget code"}
              <textarea
                className="textarea programme-embed-code"
                value={code}
                readOnly
                rows={output === "iframe" ? 6 : 9}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="programme-embed-copy-row">
              <p
                className={
                  copyState === "failed" ? "validation-item error" : "help"
                }
                role={copyState === "failed" ? "alert" : "status"}
              >
                {heightError
                  ? "Fix the initial height before copying installation code."
                  : copyState === "copied"
                    ? "Installation code copied."
                    : copyState === "failed"
                      ? "Clipboard access failed. Select and copy the code manually."
                      : "Configuration is kept only in this page until you copy it."}
              </p>
              <button
                className="btn primary"
                type="button"
                disabled={heightError !== null}
                onClick={() => void copyCode()}
              >
                {copyState === "copied" ? (
                  <Check aria-hidden size={14} />
                ) : (
                  <Clipboard aria-hidden size={14} />
                )}
                {copyState === "copied" ? "Copied" : "Copy code"}
              </button>
            </div>
          </div>

          <div className="row-main programme-embed-feeds">
            <a
              className="btn small"
              href={`/api/v1/public/events/${publicSlug}/programme?format=json`}
            >
              Static JSON
            </a>
            <a
              className="btn small"
              href={`/api/v1/public/events/${publicSlug}/programme?format=html`}
            >
              Static HTML
            </a>
            <a
              className="btn small"
              href={`/api/v1/public/events/${publicSlug}/calendar.ics`}
            >
              iCal feed
            </a>
            <a
              className="btn small"
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open preview <ExternalLink aria-hidden size={13} />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
          <p className="help">
            Parent origins remain controlled by the deployment frame-ancestor
            policy. Every embed reads only the current published snapshot.
          </p>
        </div>
      </div>
    </section>
  );
}
