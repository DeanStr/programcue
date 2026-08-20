import { GitBranch, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Form } from "react-router";

import { CharacterCount } from "~/components/ui/character-count";
import {
  normalizeTaskTemplateDraft,
  suggestedTaskEvidenceMode,
  type TaskEvidenceMode,
  type TaskTemplateDraftValues,
  type TaskType,
  taskCompatibleEvidenceModes,
} from "~/modules/tasks/task-schema";
import type { AdminTasksData } from "~/routes/admin-tasks";

export function AdminTaskPlanPanel({
  data,
  busy,
  actionNotice,
  mode = "all",
}: {
  data: AdminTasksData;
  busy: boolean;
  actionNotice?: {
    ok?: boolean;
    committed?: boolean;
    intent?: "create-template";
    draft?: TaskTemplateDraftValues;
    errors?: Record<string, string[]>;
  };
  mode?: "all" | "plan" | "create";
}) {
  const assignableTemplates = data.templates.filter(
    (template) => template.status === "active",
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    assignableTemplates[0]?.id ?? "",
  );
  const [templateDraft, setTemplateDraft] = useState(() =>
    normalizeTaskTemplateDraft(),
  );
  useEffect(() => {
    if (actionNotice?.draft) {
      setTemplateDraft(actionNotice.draft);
    } else if (
      actionNotice?.intent === "create-template" &&
      (actionNotice.ok || actionNotice.committed)
    ) {
      setTemplateDraft(normalizeTaskTemplateDraft());
    }
  }, [actionNotice]);
  const updateTemplateDraft = <K extends keyof TaskTemplateDraftValues>(
    key: K,
    value: TaskTemplateDraftValues[K],
  ) => setTemplateDraft((current) => ({ ...current, [key]: value }));
  const {
    targetType,
    dueAnchor,
    autoAssignOnAcceptance,
    taskType,
    evidenceMode,
    dueOffsetDays,
    fixedDueDate,
    destinationUrl,
    fileScope,
    description,
  } = templateDraft;
  const compatibleEvidenceModes =
    taskCompatibleEvidenceModes[taskType] ??
    taskCompatibleEvidenceModes.checklist;
  const selectedTemplate =
    assignableTemplates.find(
      (template) => template.id === selectedTemplateId,
    ) ?? assignableTemplates[0];
  const assignmentTargets =
    selectedTemplate?.targetType === "session"
      ? data.sessions
      : selectedTemplate?.targetType === "event"
        ? [data.eventTarget]
        : data.speakers;
  const selectedTargetLabel =
    selectedTemplate?.targetType === "session"
      ? "Session"
      : selectedTemplate?.targetType === "event"
        ? "Event"
        : "Speaker";
  const showPlan = mode === "all" || mode === "plan";
  const showCreate = mode === "all" || mode === "create";
  return (
    <aside className="tasks-side stack">
      {showPlan ? (
        <section className="tasks-plan-block">
          <div className="card-title">
            <h2>Speaker travel onboarding</h2>
          </div>
          <p className="subtle">
            Create the hotel-stay and flight-reimbursement forms confirmed as
            the minimum speaker onboarding workflow. Both are due seven days
            after acceptance and assigned automatically.
          </p>
          <ul className="help">
            <li>Hotel stay requirements</li>
            <li>Flight reimbursement</li>
          </ul>
          <Form method="post" className="stack">
            <input
              type="hidden"
              name="intent"
              value="create-travel-onboarding"
            />
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="confirmed"
                value="create-travel-onboarding"
                required
              />{" "}
              I confirm these forms should be created and automatically assigned
              to speakers when a submission is accepted.
            </label>
            <button type="submit" className="btn" disabled={busy}>
              <Plus aria-hidden size={15} /> Create travel forms
            </button>
          </Form>
        </section>
      ) : null}
      {showPlan ? (
        <section className="tasks-plan-block">
          <div className="card-title">
            <h2>Assign a plan</h2>
            <GitBranch aria-hidden className="subtle" size={18} />
          </div>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="assign" />
            <input
              type="hidden"
              name="assignIntentId"
              value={data.assignIntentId}
            />
            <label className="label">
              Template
              <select
                className="select"
                name="templateId"
                required
                value={selectedTemplate?.id ?? ""}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
              >
                {assignableTemplates.map((template) => (
                  <option value={template.id} key={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              {selectedTargetLabel}
              <select className="select" name="targetId" required>
                {assignmentTargets.map((target) => (
                  <option value={target.id} key={target.id}>
                    {target.name}
                    {selectedTemplate?.targetType === "speaker" &&
                    "email" in target
                      ? ` · ${target.email}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="btn"
              disabled={
                !assignableTemplates.length || !assignmentTargets.length || busy
              }
            >
              <Plus aria-hidden size={15} /> Assign with prerequisites
            </button>
          </Form>
        </section>
      ) : null}
      {showCreate ? (
        <section
          className="tasks-plan-block"
          aria-labelledby="create-task-template"
        >
          <div className="card-title">
            <h2 id="create-task-template">Create task template</h2>
          </div>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="create-template" />
            <input type="hidden" name="intentId" value={data.intentId} />
            <label className="label">
              <span className="pc-field-label">
                <span>Name</span>
                <span className="pc-required" aria-hidden="true">
                  Required
                </span>
              </span>
              <input
                className="field"
                name="name"
                required
                value={templateDraft.name}
                onChange={(event) =>
                  updateTemplateDraft("name", event.currentTarget.value)
                }
                aria-invalid={Boolean(actionNotice?.errors?.name?.length)}
              />
            </label>
            <label className="label">
              Description
              <textarea
                className="textarea"
                name="description"
                maxLength={1_000}
                value={description}
                onChange={(event) =>
                  updateTemplateDraft("description", event.currentTarget.value)
                }
              />
              <CharacterCount value={description} maximum={1_000} />
            </label>
            <div className="form-row">
              <label className="label">
                Scope
                <select
                  className="select"
                  name="targetType"
                  value={targetType}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "targetType",
                      event.target
                        .value as TaskTemplateDraftValues["targetType"],
                    )
                  }
                >
                  <option
                    value="speaker"
                    disabled={fileScope === "session_deliverable"}
                  >
                    Speaker
                  </option>
                  <option
                    value="session"
                    disabled={fileScope === "participant_document"}
                  >
                    Session
                  </option>
                  <option value="event" disabled={taskType === "file_upload"}>
                    Event
                  </option>
                </select>
              </label>
              <label className="label">
                Type
                <select
                  className="select"
                  name="taskType"
                  value={taskType}
                  onChange={(event) => {
                    const next = event.currentTarget.value as TaskType;
                    updateTemplateDraft("taskType", next);
                    updateTemplateDraft(
                      "evidenceMode",
                      suggestedTaskEvidenceMode(next),
                    );
                    if (next !== "link_visit") {
                      updateTemplateDraft("destinationUrl", "");
                    }
                    if (next !== "file_upload") {
                      updateTemplateDraft("fileScope", "");
                    }
                  }}
                >
                  <option value="checklist">Checklist</option>
                  <option value="acknowledgement">Acknowledgement</option>
                  <option value="short_form">Short form</option>
                  <option value="file_upload">File upload</option>
                  <option value="link_visit">Link visit</option>
                  <option value="administrator_only">Administrator only</option>
                </select>
              </label>
            </div>
            {taskType === "link_visit" ? (
              <label className="label">
                <span className="pc-field-label">
                  <span>Destination URL</span>
                  <span className="pc-required" aria-hidden="true">
                    Required
                  </span>
                </span>
                <input
                  className="field"
                  name="destinationUrl"
                  type="url"
                  inputMode="url"
                  required
                  maxLength={2_048}
                  placeholder="https://example.com/participant-action"
                  value={destinationUrl}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "destinationUrl",
                      event.currentTarget.value,
                    )
                  }
                  aria-invalid={Boolean(
                    actionNotice?.errors?.configuration?.length,
                  )}
                />
                <span className="help">
                  Participants open this organizer-provided HTTPS link, then
                  explicitly acknowledge completion.
                </span>
              </label>
            ) : (
              <input type="hidden" name="destinationUrl" value="" />
            )}
            {taskType === "file_upload" ? (
              <label className="label">
                <span className="pc-field-label">
                  <span>File purpose</span>
                  <span className="pc-required" aria-hidden="true">
                    Required
                  </span>
                </span>
                <select
                  className="select"
                  name="fileScope"
                  required
                  value={fileScope}
                  onChange={(event) => {
                    const next = event.currentTarget.value as
                      | ""
                      | "participant_document"
                      | "session_deliverable";
                    updateTemplateDraft("fileScope", next);
                    if (next === "participant_document") {
                      updateTemplateDraft("targetType", "speaker");
                    } else if (next === "session_deliverable") {
                      updateTemplateDraft("targetType", "session");
                    }
                  }}
                  aria-invalid={Boolean(
                    actionNotice?.errors?.configuration?.length,
                  )}
                >
                  <option value="">Choose a file purpose</option>
                  <option value="participant_document">
                    Reusable participant document
                  </option>
                  <option value="session_deliverable">
                    Session deliverable
                  </option>
                </select>
                <span className="help">
                  Slides, posters, handouts and session videos are session
                  deliverables. Reusable documents belong to the participant.
                </span>
              </label>
            ) : (
              <input type="hidden" name="fileScope" value="" />
            )}
            <div className="form-row">
              <label className="label">
                Impact
                <select
                  className="select"
                  name="impact"
                  value={templateDraft.impact}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "impact",
                      event.currentTarget
                        .value as TaskTemplateDraftValues["impact"],
                    )
                  }
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label className="label">
                Evidence
                <select
                  className="select"
                  name="evidenceMode"
                  value={evidenceMode}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "evidenceMode",
                      event.currentTarget.value as TaskEvidenceMode,
                    )
                  }
                >
                  {compatibleEvidenceModes.map((mode) => (
                    <option value={mode} key={mode}>
                      {
                        {
                          none: "None",
                          checkbox: "Checkbox",
                          file: "File",
                          text: "Text",
                          link: "Link",
                          admin_approval: "Administrator approval",
                        }[mode]
                      }
                    </option>
                  ))}
                </select>
                <span className="help">
                  {compatibleEvidenceModes.length > 1
                    ? `Choose an accepted evidence type for ${taskType.replaceAll("_", " ")} tasks.`
                    : `Required evidence type for ${taskType.replaceAll("_", " ")} tasks.`}
                </span>
              </label>
            </div>
            <label className="label">
              Due date anchor
              <select
                className="select"
                name="dueAnchor"
                value={dueAnchor}
                onChange={(event) => {
                  const next = event.target
                    .value as TaskTemplateDraftValues["dueAnchor"];
                  updateTemplateDraft("dueAnchor", next);
                  if (next === "session_start")
                    updateTemplateDraft("autoAssignOnAcceptance", false);
                }}
              >
                <option value="none">None</option>
                <option value="acceptance">Acceptance date</option>
                <option value="session_start">Session start</option>
                <option value="fixed">Fixed date</option>
              </select>
            </label>
            {dueAnchor === "acceptance" || dueAnchor === "session_start" ? (
              <label className="label">
                Offset days
                <input
                  className="field"
                  type="number"
                  name="dueOffsetDays"
                  min={-365}
                  max={365}
                  value={dueOffsetDays}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "dueOffsetDays",
                      event.currentTarget.value,
                    )
                  }
                  placeholder="e.g. 14 or -7"
                  required
                />
                <span className="help">
                  Negative is before the anchor; positive is after it.
                </span>
              </label>
            ) : (
              <input type="hidden" name="dueOffsetDays" value="" />
            )}
            {dueAnchor === "fixed" ? (
              <label className="label">
                Fixed due date
                <input
                  className="field"
                  type="date"
                  name="fixedDueDate"
                  value={fixedDueDate}
                  onChange={(event) =>
                    updateTemplateDraft(
                      "fixedDueDate",
                      event.currentTarget.value,
                    )
                  }
                  required
                />
                <span className="help">
                  Ends at 11:59 PM in {data.eventTimezone}.
                </span>
              </label>
            ) : (
              <input type="hidden" name="fixedDueDate" value="" />
            )}
            {dueAnchor !== "none" ? (
              <div className="validation-item info" role="status">
                <strong>Deadline preview</strong>
                <span>
                  {dueAnchor === "fixed"
                    ? fixedDueDate
                      ? `Due ${fixedDueDate} at 11:59 PM (${data.eventTimezone}).`
                      : "Choose the fixed due date."
                    : dueOffsetDays
                      ? `Due ${Math.abs(Number(dueOffsetDays))} day${Math.abs(Number(dueOffsetDays)) === 1 ? "" : "s"} ${Number(dueOffsetDays) < 0 ? "before" : "after"} ${dueAnchor === "acceptance" ? "acceptance" : "session start"}.`
                      : "Enter the number of days from the selected anchor."}
                </span>
              </div>
            ) : null}
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="autoAssignOnAcceptance"
                value="true"
                checked={autoAssignOnAcceptance}
                disabled={dueAnchor === "session_start"}
                onChange={(event) =>
                  updateTemplateDraft(
                    "autoAssignOnAcceptance",
                    event.target.checked,
                  )
                }
              />{" "}
              Add this task automatically when a submission is accepted
            </label>
            <span className="help">
              Prerequisites are included automatically. Session-start deadlines
              require a scheduled session and cannot be created at acceptance.
            </span>
            {data.templates.length ? (
              <fieldset>
                <legend className="label">Prerequisites</legend>
                <div className="task-dependency-list">
                  {data.templates
                    .filter(
                      (template) =>
                        template.status === "active" &&
                        template.targetType === targetType,
                    )
                    .map((template) => (
                      <label className="speaker-confirm" key={template.id}>
                        <input
                          type="checkbox"
                          name="dependencyIds"
                          value={template.id}
                          checked={templateDraft.dependencyIds.includes(
                            template.id,
                          )}
                          onChange={(event) =>
                            updateTemplateDraft(
                              "dependencyIds",
                              event.target.checked
                                ? [...templateDraft.dependencyIds, template.id]
                                : templateDraft.dependencyIds.filter(
                                    (id) => id !== template.id,
                                  ),
                            )
                          }
                        />{" "}
                        {template.name}
                      </label>
                    ))}
                </div>
              </fieldset>
            ) : null}
            <button type="submit" className="btn">
              <Plus aria-hidden size={15} /> Create template
            </button>
          </Form>
        </section>
      ) : null}
    </aside>
  );
}
