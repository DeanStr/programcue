import { ExternalLink } from "lucide-react";
import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import { DerivedSlugField } from "~/components/ui/derived-slug-field";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { ProgrammeEmbedBuilderController } from "./use-programme-embed-builder";

export function ManagedEmbedWorkflow({
  workflow,
  onOpenBuilder,
}: {
  workflow: ProgrammeEmbedBuilderController["managedWorkflow"];
  onOpenBuilder(): void;
}) {
  const {
    actionData,
    selectedEmbed,
    outputConfiguration,
    managedName,
    managedSlug,
    publicSlug,
    installationNote,
    changedConfigurationFields,
    managedConfirmed,
    selectedManagedUrl,
    output,
    selectedManagedCode,
    managedEmbeds,
    timezone,
    selectedEmbedId,
    reset,
    setManagedName,
    setManagedSlug,
    setInstallationNote,
    setManagedConfirmed,
    loadManagedEmbed,
  } = workflow;
  return (
    <div
      className="programme-managed-embeds stack"
      id="managed-programme-embeds"
    >
      <div className="programme-panel-heading">
        <h2>Managed embeds</h2>
        <p className="help">
          Save a named configuration behind a stable URL. Stateless snippets
          remain available and unchanged; new drafts use the current Embed
          builder configuration.
        </p>
      </div>
      {actionData?.message ? (
        <p
          className={
            actionData.ok ? "validation-item success" : "validation-item error"
          }
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.message}
        </p>
      ) : null}

      <Form
        method="post"
        action="/admin/programme#managed-programme-embeds"
        className="programme-managed-form stack"
      >
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
            <h3>
              {selectedEmbed
                ? `Edit ${selectedEmbed.name}`
                : "Save a new draft"}
            </h3>
            <p className="help">
              {selectedEmbed
                ? `Stable slug ${selectedEmbed.slug} cannot be changed. Current revision ${selectedEmbed.revision}.`
                : "The stable slug is permanent, including after revocation."}
            </p>
          </div>
          {selectedEmbed ? (
            <Button size="small" type="button" onClick={reset}>
              New draft
            </Button>
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
          <DerivedSlugField
            source={managedName}
            value={managedSlug}
            onChange={(value) => {
              setManagedSlug(value);
              setManagedConfirmed(false);
            }}
            name="slug"
            label="Stable slug"
            maximumLength={80}
            initiallyDerived={!selectedEmbed}
            resetKey={selectedEmbed?.id ?? "new"}
            publicPathPrefix={`/embed/${publicSlug}/saved/`}
            disabled={Boolean(selectedEmbed)}
          />
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
                Revision {selectedEmbed.revision} → {selectedEmbed.revision + 1}
                .
                {changedConfigurationFields.length
                  ? ` Configuration changes: ${changedConfigurationFields.join(", ")}.`
                  : " Configuration values are unchanged."}
                {selectedEmbed.name !== managedName.trim()
                  ? " Name will change."
                  : ""}
                {(selectedEmbed.installationNote ?? "") !==
                installationNote.trim()
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
          <Button
            type="submit"
            variant="primary"
            disabled={
              outputConfiguration === null ||
              !managedName.trim() ||
              (!selectedEmbed && !managedSlug.trim()) ||
              (Boolean(selectedEmbed) && !managedConfirmed)
            }
          >
            {selectedEmbed ? "Confirm update" : "Save draft"}
          </Button>
        </div>
      </Form>

      {selectedEmbed && selectedManagedUrl ? (
        <div className="programme-managed-form stack">
          <h3>Stable installation</h3>
          <p className="help">
            This URL does not change when the configuration revision changes.
          </p>
          <a
            href={selectedManagedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
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
        <section
          className="table-wrap"
          aria-label="Managed programme embeds"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
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
                    <td>
                      <span className="status info">{embed.status}</span>
                    </td>
                    <td>{embed.revision}</td>
                    <td>{embed.installationNote ?? "—"}</td>
                    <td className="programme-managed-updated">
                      <EventDateTime
                        epochSeconds={embed.updatedAt}
                        timeZone={timezone}
                      />
                      <small className="subtle">by {embed.updatedByName}</small>
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
                          <Button
                            size="small"
                            type="button"
                            onClick={() => {
                              loadManagedEmbed(embed);
                              onOpenBuilder();
                            }}
                          >
                            Load in builder
                          </Button>
                        ) : null}
                        {nextStatus ? (
                          <Form
                            method="post"
                            action="/admin/programme#managed-programme-embeds"
                            className="stack"
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="transition-managed-embed"
                            />
                            <input type="hidden" name="id" value={embed.id} />
                            <input
                              type="hidden"
                              name="revision"
                              value={embed.revision}
                            />
                            <input
                              type="hidden"
                              name="nextStatus"
                              value={nextStatus}
                            />
                            <label className="choice">
                              <input
                                type="checkbox"
                                name="confirmed"
                                value="yes"
                                required
                              />
                              {nextStatus === "active"
                                ? "I previewed this configuration."
                                : "I confirm visitors will see an unavailable response."}
                            </label>
                            <Button
                              type="submit"
                              size="small"
                              disabled={
                                nextStatus === "active" &&
                                (selectedEmbedId !== embed.id ||
                                  changedConfigurationFields.length > 0)
                              }
                            >
                              {nextStatus === "active"
                                ? embed.status === "paused"
                                  ? "Resume"
                                  : "Activate"
                                : "Pause"}
                            </Button>
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
                          <Form
                            method="post"
                            action="/admin/programme#managed-programme-embeds"
                            className="stack"
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="transition-managed-embed"
                            />
                            <input type="hidden" name="id" value={embed.id} />
                            <input
                              type="hidden"
                              name="revision"
                              value={embed.revision}
                            />
                            <input
                              type="hidden"
                              name="nextStatus"
                              value="revoked"
                            />
                            <label className="choice">
                              <input
                                type="checkbox"
                                name="confirmed"
                                value="yes"
                                required
                              />
                              I understand this URL will permanently return 410.
                            </label>
                            <Button type="submit" variant="danger" size="small">
                              Revoke
                            </Button>
                          </Form>
                        ) : (
                          <span className="help">
                            Stable slug permanently reserved.
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="help">No managed embeds have been saved yet.</p>
      )}
    </div>
  );
}
