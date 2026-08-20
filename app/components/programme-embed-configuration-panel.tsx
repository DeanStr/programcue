import { Check, Clipboard, ExternalLink, RotateCcw } from "lucide-react";
import {
  PROGRAMME_EMBED_CONTROLS,
  PROGRAMME_EMBED_FIELDS,
  PROGRAMME_EMBED_SURFACES,
  type ProgrammeEmbedConfiguration,
  type ProgrammeEmbedControl,
  type ProgrammeEmbedField,
  type ProgrammeEmbedSurface,
} from "~/modules/programme/programme-embed-configuration";
import {
  type ProgrammeEmbedBuilderController,
  programmeEmbedSurfaceDescriptions,
  programmeEmbedSurfaceLabels,
} from "./use-programme-embed-builder";

const controlLabels: Record<ProgrammeEmbedControl, string> = {
  search: "Search",
  day: "Day",
  track: "Track",
  format: "Format",
  room: "Room",
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

export function EmbedConfigurationWorkflow({
  workflow,
  eventAccent,
}: {
  workflow: ProgrammeEmbedBuilderController["configurationWorkflow"];
  eventAccent: string;
}) {
  const {
    configuration,
    days,
    tracks,
    formats,
    rooms,
    heightInput,
    heightError,
    previewWidth,
    previewUrl,
    eventName,
    output,
    code,
    copyState,
    publicSlug,
    reset,
    update,
    toggleControl,
    toggleField,
    setHeightInput,
    setCopyState,
    setManagedConfirmed,
    setPreviewWidth,
    setOutput,
    copyCode,
  } = workflow;
  return (
    <>
      <div className="card-title programme-embed-builder-title">
        <p className="help">
          Choose the initial view, preview the published result, then copy
          installation code.
        </p>
        <button className="btn small" type="button" onClick={reset}>
          <RotateCcw aria-hidden size={14} /> Reset
        </button>
      </div>

      <div className="programme-embed-builder-layout">
        <div className="programme-embed-configuration">
          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Widget type</legend>
            <label className="label">
              Public surface
              <select
                className="select"
                value={configuration.surface}
                onChange={(event) =>
                  update("surface", event.target.value as ProgrammeEmbedSurface)
                }
              >
                {PROGRAMME_EMBED_SURFACES.filter(
                  (surface) => surface === "sessions" || surface === "speakers",
                ).map((surface) => (
                  <option key={surface} value={surface}>
                    {programmeEmbedSurfaceLabels[surface]}
                  </option>
                ))}
                <optgroup label="Schedule">
                  {(["timetable", "schedule"] as const).map((surface) => (
                    <option key={surface} value={surface}>
                      {programmeEmbedSurfaceLabels[surface]}
                    </option>
                  ))}
                </optgroup>
                <option value="gallery">
                  {programmeEmbedSurfaceLabels.gallery}
                </option>
              </select>
              <span className="help">
                {programmeEmbedSurfaceDescriptions[configuration.surface]}
              </span>
            </label>
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Initial filters</legend>
            <div className="programme-embed-filter-grid">
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
            </div>
          </fieldset>

          <fieldset className="pc-plain-fieldset stack">
            <legend className="label">Visible visitor controls</legend>
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
                Theme
                <select
                  className="select"
                  value={configuration.theme}
                  onChange={(event) =>
                    update(
                      "theme",
                      event.target
                        .value as ProgrammeEmbedConfiguration["theme"],
                    )
                  }
                >
                  <option value="system">Follow visitor system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
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
                    setManagedConfirmed(false);
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
            <fieldset
              className="segmented pc-plain-fieldset"
              aria-label="Preview width"
            >
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
            </fieldset>
          </div>
          <div
            className={`programme-embed-preview ${previewWidth}`}
            data-preview-width={previewWidth}
          >
            {/* This is trusted Program Cue code on the parent application's
                own origin. Combining scripts and same-origin in a sandbox is
                ineffective here and produces a browser escape warning. The
                generated customer iframe remains sandboxed. */}
            <iframe
              key={previewUrl}
              src={previewUrl}
              title={`${eventName} embed preview`}
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
              <label className="label">
                Installation format
                <select
                  className="select"
                  value={output}
                  onChange={(event) => {
                    setOutput(event.currentTarget.value as typeof output);
                    setCopyState("idle");
                  }}
                >
                  <option value="iframe">Iframe code</option>
                  <option value="widget">Auto-resizing script widget</option>
                </select>
              </label>
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
    </>
  );
}
