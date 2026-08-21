import {
  CheckCircle2,
  ExternalLink,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Form, Link } from "react-router";
import { requireValue } from "~/lib/required-value";

import type {
  AiAssistantResult,
  AiProposalPreview,
  ContextualAiResult,
} from "./ai-types";

const domainApprovalCopy = {
  propose_form_draft: {
    confirmation: "I reviewed the exact form settings and fields.",
    button: "Approve and save form draft",
  },
  propose_rubric_update: {
    confirmation: "I reviewed every criterion, weight and required setting.",
    button: "Approve and update rubric",
  },
  propose_reviewer_assignment: {
    confirmation: "I reviewed every target and authorised reviewer.",
    button: "Approve reviewer assignments",
  },
  propose_email_template_draft: {
    confirmation: "I reviewed the exact subject, content, footer and action.",
    button: "Approve and save email draft",
  },
  propose_schedule_placement: {
    confirmation: "I reviewed the exact room, time and deterministic warnings.",
    button: "Approve session placement",
  },
  propose_form_publication: {
    confirmation: "I reviewed the exact public form version and fields.",
    button: "Approve and publish form",
  },
  propose_schedule_publication: {
    confirmation: "I reviewed every scheduled session and the public effect.",
    button: "Approve and publish schedule",
  },
  propose_accelevents_run: {
    confirmation:
      "I reviewed every external create, update and unchanged record.",
    button: "Approve Accelevents run",
  },
} as const;

function Attribution({
  attribution,
}: {
  attribution: AiAssistantResult["attribution"];
}) {
  return (
    <p className="help">
      <Sparkles aria-hidden size={13} /> AI-generated advisory output ·{" "}
      {attribution.provider} {attribution.model} · response{" "}
      {attribution.responseId}
    </p>
  );
}

function EvidenceList({
  evidence,
  compact = false,
}: {
  evidence: AiAssistantResult["evidence"];
  compact?: boolean;
}) {
  if (!evidence.length) return null;
  const items = (
    <div className="stack">
      {evidence.map((item) => (
        <Link className="card pad" to={item.href} key={item.id}>
          <strong>{item.label}</strong>
          <p className="subtle">{item.detail}</p>
          <small className="help">
            {item.source} <ExternalLink aria-hidden size={12} />
          </small>
        </Link>
      ))}
    </div>
  );
  return compact ? (
    <details className="pc-disclosure">
      <summary>
        Sources inspected ({evidence.length}) · authorised Program Cue records
      </summary>
      <div className="mt">{items}</div>
    </details>
  ) : (
    <section className="card pad">
      <div className="card-title">
        <h3>Inspected evidence</h3>
        <span className="status success">
          <ShieldCheck aria-hidden size={13} /> Authorised
        </span>
      </div>
      {items}
    </section>
  );
}

function ReadinessAdvisoryPanel({ result }: { result: ContextualAiResult }) {
  if (!result.readiness) {
    throw new Error(
      "The readiness AI result is missing its validated structured advisory.",
    );
  }
  const readiness = result.readiness;
  const statusTone =
    readiness.status === "ready"
      ? "success"
      : readiness.status === "at_risk"
        ? "danger"
        : "warning";
  return (
    <section className="card pad" aria-live="polite">
      <div className="card-title">
        <div>
          <h3>{result.title}</h3>
          <p className="subtle">
            Snapshot {readiness.generatedAt.slice(0, 19).replace("T", " ")} UTC
          </p>
        </div>
        <span className={`status ${statusTone}`}>
          {readiness.percentage}% · {readiness.status.replaceAll("_", " ")}
        </span>
      </div>
      <p>{readiness.summary}</p>
      <p className="help">
        {readiness.declaredBlockers} recorded blocker
        {readiness.declaredBlockers === 1 ? "" : "s"}. Program Cue calculates
        readiness; AI only prioritises the recorded evidence.
      </p>
      {readiness.priorities.length ? (
        <div className="stack">
          <h4>Recommended next actions</h4>
          <ol className="stack">
            {readiness.priorities.map((priority) => (
              <li className="card pad" key={priority.blockerKey}>
                <div className="card-title">
                  <strong>{priority.label}</strong>
                  <span className={`status ${priority.severity}`}>
                    {priority.severity === "danger"
                      ? "Critical"
                      : "Needs attention"}
                    {" · "}
                    {priority.count} affected
                  </span>
                </div>
                <p className="subtle">{priority.detail}</p>
                <p>
                  <strong>Why AI ranked this:</strong> {priority.rationale}
                </p>
                <Link className="btn small" to={priority.href}>
                  {priority.action}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="status success">No recorded readiness blockers.</p>
      )}
      {readiness.uncertainties.length ? (
        <div>
          <h4>Uncertainties</h4>
          <ul>
            {readiness.uncertainties.map((uncertainty) => (
              <li key={uncertainty}>{uncertainty}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Attribution attribution={result.attribution} />
      <EvidenceList evidence={result.evidence} compact />
    </section>
  );
}

export function ProposalApproval({
  proposal,
  executedTaskId,
  executedCommunicationId,
  executedOperationId,
  executedDomainEntityId,
  executedHref,
  expired = false,
}: {
  proposal: AiProposalPreview;
  executedTaskId?: string | null;
  executedCommunicationId?: string | null;
  executedOperationId?: string | null;
  executedDomainEntityId?: string | null;
  executedHref?: string | null;
  expired?: boolean;
}) {
  const executed = Boolean(
    executedTaskId || executedCommunicationId || executedDomainEntityId,
  );
  const reminder =
    proposal.toolName === "propose_reminder_send" ? proposal.reminder : null;
  const domainCopy =
    proposal.toolName !== "propose_task" &&
    proposal.toolName !== "propose_reminder_send"
      ? domainApprovalCopy[proposal.toolName]
      : null;
  return (
    <section className="card pad" data-proposal-id={proposal.id}>
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Write preview</span>
          <h3>{proposal.title}</h3>
        </div>
        <span
          className={`status ${executed ? "success" : expired ? "danger" : "warning"}`}
        >
          {executed ? "Executed" : expired ? "Expired" : "Approval required"}
        </span>
      </div>
      <p>{proposal.summary}</p>
      <section
        className="table-wrap"
        aria-label="Proposed changes"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Current</th>
              <th scope="col">After approval</th>
            </tr>
          </thead>
          <tbody>
            {proposal.changes.map((change) => (
              <tr key={change.field}>
                <th scope="row">{change.field}</th>
                <td>{change.before ?? "Not created"}</td>
                <td>{change.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="help">{proposal.consequence}</p>
      {proposal.affectedRecords?.length ? (
        <details className="pc-disclosure">
          <summary>
            Review all {proposal.affectedRecords.length} affected records
          </summary>
          <div className="stack">
            {proposal.affectedRecords.map((record) => (
              <Link className="card pad" to={record.href} key={record.id}>
                <strong>{record.label}</strong>
                <p className="subtle">{record.detail}</p>
              </Link>
            ))}
          </div>
        </details>
      ) : null}
      {reminder ? (
        <div className="stack">
          <section className="card pad">
            <div className="card-title">
              <h4>Exact communication snapshot</h4>
              <span className="status info">
                {reminder.kind} · {reminder.audienceType.replaceAll("_", " ")}
              </span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Template version</dt>
                <dd>
                  {reminder.template.name} · v{reminder.template.versionNumber}
                </dd>
              </div>
              <div>
                <dt>Sender</dt>
                <dd>{reminder.provider.sender}</dd>
              </div>
              <div>
                <dt>Footer</dt>
                <dd>{reminder.template.content.physicalAddress}</dd>
              </div>
              {reminder.template.content.buttonText &&
              reminder.template.content.buttonUrl ? (
                <div>
                  <dt>Action</dt>
                  <dd>
                    {reminder.template.content.buttonText} ·{" "}
                    {reminder.template.content.buttonUrl}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          {!executed && !expired ? (
            <Form method="post" action="/admin/assistant" className="stack">
              <input type="hidden" name="intent" value="revise" />
              <input type="hidden" name="proposalId" value={proposal.id} />
              <label className="label">
                Subject
                <input
                  className="input"
                  type="text"
                  name="subject"
                  minLength={3}
                  maxLength={200}
                  required
                  defaultValue={reminder.template.subject}
                />
              </label>
              <label className="label">
                Message template
                <textarea
                  className="textarea"
                  name="body"
                  minLength={10}
                  maxLength={100_000}
                  rows={9}
                  required
                  defaultValue={reminder.template.content.body}
                />
              </label>
              <p className="help">
                Editing does not send. Update the preview to create a new
                immutable template version and re-resolve every recipient before
                approval.
              </p>
              <button className="btn" type="submit">
                Update exact preview
              </button>
            </Form>
          ) : (
            <div style={{ whiteSpace: "pre-wrap" }}>
              <strong>{reminder.template.subject}</strong>
              {"\n\n"}
              {reminder.template.content.body}
            </div>
          )}

          <details className="pc-disclosure">
            <summary>
              Review all {reminder.recipients.selected} selected recipients
            </summary>
            <section
              className="table-wrap"
              aria-label="Selected communication recipients"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Delivery state</th>
                    <th scope="col">Recipient</th>
                    <th scope="col">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {reminder.recipients.deliverable.map((recipient) => (
                    <tr key={`deliverable:${recipient.address}`}>
                      <td>
                        <span className="status success">Deliverable</span>
                      </td>
                      <td>{recipient.name}</td>
                      <td>{recipient.address}</td>
                    </tr>
                  ))}
                  {reminder.recipients.suppressed.map((recipient) => (
                    <tr key={`suppressed:${recipient.address}`}>
                      <td>
                        <span className="status warning">Suppressed</span>
                      </td>
                      <td>{recipient.name}</td>
                      <td>{recipient.address}</td>
                    </tr>
                  ))}
                  {reminder.recipients.invalid.map((recipient) => (
                    <tr key={`invalid:${recipient.address}`}>
                      <td>
                        <span className="status danger">Invalid</span>
                      </td>
                      <td>{recipient.name || "Unnamed recipient"}</td>
                      <td>
                        {recipient.address}
                        <div className="subtle">{recipient.reason}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </details>
        </div>
      ) : null}
      {executedTaskId ? (
        <Link
          className="btn primary"
          to={`/admin/tasks?task=${encodeURIComponent(executedTaskId)}`}
        >
          <CheckCircle2 aria-hidden size={14} /> Open created task
        </Link>
      ) : executedCommunicationId && executedOperationId ? (
        <Link
          className="btn primary"
          to={`/admin/operations?operation=${encodeURIComponent(executedOperationId)}`}
        >
          <CheckCircle2 aria-hidden size={14} /> Open communication operation
        </Link>
      ) : executedDomainEntityId && executedHref ? (
        <Link className="btn primary" to={executedHref}>
          <CheckCircle2 aria-hidden size={14} /> Open approved result
        </Link>
      ) : expired ? (
        <p className="help">
          Generate a fresh preview so current event validation runs again.
        </p>
      ) : (
        <Form method="post" action="/admin/assistant" className="stack">
          <input type="hidden" name="intent" value="approve" />
          <input type="hidden" name="proposalId" value={proposal.id} />
          <label className="check-row">
            <input type="checkbox" name="confirmed" value="yes" required />
            <span>
              {reminder
                ? `I reviewed the exact template and ${reminder.recipients.deliverable.length} deliverable recipients. I approve queueing this irreversible send.`
                : proposal.toolName === "propose_task"
                  ? "I reviewed the exact change and approve creating this one task."
                  : `${requireValue(domainCopy, "Required domainCopy is unavailable.").confirmation} I approve this action.`}
            </span>
          </label>
          <button className="btn primary" type="submit">
            {reminder ? (
              <>
                <Send aria-hidden size={14} /> Approve and queue reminder
              </>
            ) : proposal.toolName === "propose_task" ? (
              "Approve and create task"
            ) : (
              requireValue(domainCopy, "Required domainCopy is unavailable.")
                .button
            )}
          </button>
        </Form>
      )}
    </section>
  );
}

export function AssistantResultPanel({
  result,
  showProposals = true,
}: {
  result: AiAssistantResult;
  showProposals?: boolean;
}) {
  return (
    <div className="stack" aria-live="polite">
      <section className="card pad">
        <div className="card-title">
          <h2>Assistant answer</h2>
          <span className="status info">Advisory</span>
        </div>
        <div style={{ whiteSpace: "pre-wrap" }}>{result.answer}</div>
        <Attribution attribution={result.attribution} />
        <Link
          className="btn small"
          to={`/admin/operations?operation=${encodeURIComponent(result.operationId)}`}
        >
          Open assistant operation
        </Link>
      </section>
      {showProposals
        ? result.proposals.map((proposal) => (
            <ProposalApproval proposal={proposal} key={proposal.id} />
          ))
        : null}
      <EvidenceList evidence={result.evidence} />
    </div>
  );
}

export function ContextualAiResultPanel({
  result,
}: {
  result: ContextualAiResult;
}) {
  if (result.kind === "readiness_summary") {
    return <ReadinessAdvisoryPanel result={result} />;
  }
  const editable =
    result.kind === "reminder_draft" || result.kind === "session_copy";
  return (
    <section className="card pad" aria-live="polite">
      <div className="card-title">
        <h3>{result.title}</h3>
        <span className="status info">AI advisory</span>
      </div>
      {editable ? (
        <label className="label">
          Editable AI draft
          <textarea
            className="textarea"
            rows={10}
            defaultValue={result.content}
            key={result.attribution.responseId}
          />
        </label>
      ) : (
        <div style={{ whiteSpace: "pre-wrap" }}>{result.content}</div>
      )}
      <Attribution attribution={result.attribution} />
      <EvidenceList evidence={result.evidence} />
    </section>
  );
}
