import { Check, Clipboard, ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Form, useActionData } from "react-router";

import { EventDateTime } from "~/components/ui/event-date-time";
import {
  defaultProgrammeEmbedConfiguration,
  managedProgrammeEmbedUrl,
  managedProgrammeWidgetSnippet,
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
import type { ManagedProgrammeEmbed } from "~/modules/programme/programme-embed-service.server";

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
  managedEmbeds,
}: {
  publicOrigin: string;
  publicSlug: string;
  eventName: string;
  eventAccent: string;
  timezone: string;
  sessions: EmbedSession[];
  managedEmbeds: ManagedProgrammeEmbed[];
}) {
  const actionData = useActionData() as
    | { ok?: boolean; message?: string }
    | undefined;
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
  const [selectedEmbedId, setSelectedEmbedId] = useState<string | null>(null);
  const [managedName, setManagedName] = useState("");
  const [managedSlug, setManagedSlug] = useState("");
  const [installationNote, setInstallationNote] = useState("");
  const [managedConfirmed, setManagedConfirmed] = useState(false);
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
  const selectedEmbed = managedEmbeds.find(
    (embed) => embed.id === selectedEmbedId,
  );
  const selectedManagedUrl = selectedEmbed
    ? managedProgrammeEmbedUrl(publicOrigin, publicSlug, selectedEmbed.slug)
    : null;
  const selectedManagedCode =
    selectedEmbed && outputConfiguration
      ? output === "iframe"
        ? programmeIframeSnippet(
            selectedManagedUrl!,
            `${eventName} ${selectedEmbed.name}`,
            outputConfiguration.height,
          )
        : managedProgrammeWidgetSnippet({
            origin: publicOrigin,
            eventSlug: publicSlug,
            embedSlug: selectedEmbed.slug,
            target: `programcue-${publicSlug}-${selectedEmbed.slug}`,
            title: `${eventName} ${selectedEmbed.name}`,
            height: outputConfiguration.height,
          })
      : "";
  const changedConfigurationFields = selectedEmbed
    ? (Object.keys(selectedEmbed.configuration) as Array<
        keyof ProgrammeEmbedConfiguration
      >).filter(
        (key) =>
          JSON.stringify(selectedEmbed.configuration[key]) !==
          JSON.stringify(outputConfiguration?.[key]),
      )
    : [];

  function update<Key extends keyof ProgrammeEmbedConfiguration>(
    key: Key,
    value: ProgrammeEmbedConfiguration[Key],
  ) {
    setConfiguration((current) => ({ ...current, [key]: value }));
    setCopyState("idle");
    setManagedConfirmed(false);
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
    setSelectedEmbedId(null);
    setManagedName("");
    setManagedSlug("");
    setInstallationNote("");
    setManagedConfirmed(false);
  }

  function loadManagedEmbed(embed: ManagedProgrammeEmbed) {
    setSelectedEmbedId(embed.id);
    setManagedName(embed.name);
    setManagedSlug(embed.slug);
    setInstallationNote(embed.installationNote ?? "");
    setConfiguration({
      ...embed.configuration,
      controls: [...embed.configuration.controls],
      fields: [...embed.configuration.fields],
    });
    setHeightInput(String(embed.configuration.height));
    setManagedConfirmed(false);
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

      <div className="mt stack" id="managed-programme-embeds">
        <div>
          <span className="pc-page-eyebrow">Durable installations</span>
          <h2>Managed embeds</h2>
          <p className="help">
            Save a named configuration behind a stable URL. Stateless snippets
            above remain available and unchanged.
          </p>
        </div>
        {actionData?.message ? (
          <p
            className={actionData.ok ? "validation-item success" : "validation-item error"}
            role={actionData.ok ? "status" : "alert"}
          >
            {actionData.message}
          </p>
        ) : null}

        <Form method="post" className="card pad stack">
          <input
            type="hidden"
            name="intent"
            value={
              selectedEmbed ? "update-managed-embed" : "create-managed-embed"
            }
          />
          <input type="hidden" name="id" value={selectedEmbed?.id ?? ""} />
          <input
            type="hidden"
            name="revision"
            value={selectedEmbed?.revision ?? ""}
          />
          <input
            type="hidden"
            name="configurationJson"
            value={JSON.stringify(outputConfiguration)}
          />
          <div className="card-title">
            <div>
              <h3>{selectedEmbed ? `Edit ${selectedEmbed.name}` : "Save a new draft"}</h3>
              <p className="help">
                {selectedEmbed
                  ? `Stable slug ${selectedEmbed.slug} cannot be changed. Current revision ${selectedEmbed.revision}.`
                  : "The stable slug is permanent, including after revocation."}
              </p>
            </div>
            {selectedEmbed ? (
              <button className="btn small" type="button" onClick={reset}>
                New draft
              </button>
            ) : null}
          </div>
          <div className="grid grid-2">
            <label className="label">
              Embed name
              <input
                className="field"
                name="name"
                required
                maxLength={120}
                value={managedName}
                onChange={(event) => {
                  setManagedName(event.target.value);
                  setManagedConfirmed(false);
                }}
              />
            </label>
            <label className="label">
              Stable slug
              <input
                className="field"
                name="slug"
                required={!selectedEmbed}
                disabled={Boolean(selectedEmbed)}
                maxLength={80}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                value={managedSlug}
                onChange={(event) => setManagedSlug(event.target.value)}
                placeholder="conference-homepage"
              />
            </label>
          </div>
          <label className="label">
            Installation note (optional)
            <textarea
              className="textarea"
              name="installationNote"
              maxLength={500}
              rows={2}
              value={installationNote}
              onChange={(event) => {
                setInstallationNote(event.target.value);
                setManagedConfirmed(false);
              }}
              placeholder="Customer-entered location, owner or handoff note"
            />
          </label>
          {selectedEmbed ? (
            <>
              <div className="notice">
                <strong>Before/after preview</strong>
                <p className="help">
                  Revision {selectedEmbed.revision} → {selectedEmbed.revision + 1}.
                  {changedConfigurationFields.length
                    ? ` Configuration changes: ${changedConfigurationFields.join(", ")}.`
                    : " Configuration values are unchanged."}
                  {selectedEmbed.name !== managedName.trim()
                    ? " Name will change."
                    : ""}
                  {(selectedEmbed.installationNote ?? "") !== installationNote.trim()
                    ? " Installation note will change."
                    : ""}
                </p>
              </div>
              <label className="choice">
                <input
                  type="checkbox"
                  name="confirmed"
                  value="yes"
                  checked={managedConfirmed}
                  onChange={(event) => setManagedConfirmed(event.target.checked)}
                />
                I reviewed the live preview and this before/after summary.
              </label>
            </>
          ) : null}
          <div className="page-actions">
            <button
              className="btn primary"
              disabled={
                outputConfiguration === null ||
                !managedName.trim() ||
                (!selectedEmbed && !managedSlug.trim()) ||
                (Boolean(selectedEmbed) && !managedConfirmed)
              }
            >
              {selectedEmbed ? "Confirm update" : "Save draft"}
            </button>
          </div>
        </Form>

        {selectedEmbed && selectedManagedUrl ? (
          <div className="card pad stack">
            <h3>Stable installation</h3>
            <p className="help">
              This URL does not change when the configuration revision changes.
            </p>
            <a href={selectedManagedUrl} target="_blank" rel="noopener noreferrer">
              {selectedManagedUrl} <ExternalLink aria-hidden size={13} />
            </a>
            <label className="label">
              Managed {output === "iframe" ? "iframe" : "widget"} code
              <textarea
                className="textarea programme-embed-code"
                value={selectedManagedCode}
                readOnly
                rows={output === "iframe" ? 6 : 7}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          </div>
        ) : null}

        {managedEmbeds.length ? (
          <div className="table-wrap" role="region" aria-label="Managed programme embeds" tabIndex={0}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Embed</th>
                  <th scope="col">Status</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Installation note</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {managedEmbeds.map((embed) => {
                  const nextStatus =
                    embed.status === "draft" || embed.status === "paused"
                      ? "active"
                      : embed.status === "active"
                        ? "paused"
                        : null;
                  return (
                    <tr key={embed.id}>
                      <td>
                        <strong>{embed.name}</strong>
                        <div className="help">{embed.slug}</div>
                      </td>
                      <td><span className="status info">{embed.status}</span></td>
                      <td>{embed.revision}</td>
                      <td>{embed.installationNote ?? "—"}</td>
                      <td>
                        <EventDateTime
                          epochSeconds={embed.updatedAt}
                          timeZone={timezone}
                        />
                        <small className="subtle">
                          by {embed.updatedByName}
                        </small>
                        <small className="subtle">
                          Created{" "}
                          <EventDateTime
                            epochSeconds={embed.createdAt}
                            timeZone={timezone}
                          />{" "}
                          by {embed.createdByName}
                        </small>
                      </td>
                      <td>
                        <div className="stack">
                          {embed.status !== "revoked" ? (
                            <button className="btn small" type="button" onClick={() => loadManagedEmbed(embed)}>
                              Load and preview
                            </button>
                          ) : null}
                          {nextStatus ? (
                            <Form method="post" className="stack">
                              <input type="hidden" name="intent" value="transition-managed-embed" />
                              <input type="hidden" name="id" value={embed.id} />
                              <input type="hidden" name="revision" value={embed.revision} />
                              <input type="hidden" name="nextStatus" value={nextStatus} />
                              <label className="choice">
                                <input type="checkbox" name="confirmed" value="yes" required />
                                {nextStatus === "active"
                                  ? "I previewed this configuration."
                                  : "I confirm visitors will see an unavailable response."}
                              </label>
                              <button
                                className="btn small"
                                disabled={
                                  nextStatus === "active" &&
                                  (selectedEmbedId !== embed.id ||
                                    changedConfigurationFields.length > 0)
                                }
                              >
                                {nextStatus === "active"
                                  ? embed.status === "paused" ? "Resume" : "Activate"
                                  : "Pause"}
                              </button>
                              {nextStatus === "active" &&
                              (selectedEmbedId !== embed.id ||
                                changedConfigurationFields.length > 0) ? (
                                <span className="help">
                                  Load this saved revision into the live preview
                                  before activation.
                                </span>
                              ) : null}
                            </Form>
                          ) : null}
                          {embed.status !== "revoked" ? (
                            <Form method="post" className="stack">
                              <input type="hidden" name="intent" value="transition-managed-embed" />
                              <input type="hidden" name="id" value={embed.id} />
                              <input type="hidden" name="revision" value={embed.revision} />
                              <input type="hidden" name="nextStatus" value="revoked" />
                              <label className="choice">
                                <input type="checkbox" name="confirmed" value="yes" required />
                                I understand this URL will permanently return 410.
                              </label>
                              <button className="btn small danger">Revoke</button>
                            </Form>
                          ) : (
                            <span className="help">Stable slug permanently reserved.</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="help">No managed embeds have been saved yet.</p>
        )}
      </div>
    </section>
  );
}
