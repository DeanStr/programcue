import { Sparkles } from "lucide-react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import type { AiProposalPreview, ContextualAiResult } from "./ai-types";
import {
  ContextualAiResultPanel,
  ProposalApproval,
} from "./assistant-result-panel";

type ContextActionResponse =
  | {
      ok: true;
      result: ContextualAiResult;
      proposal: AiProposalPreview | null;
    }
  | { ok: false; error: string };

function ContextAction({
  kind,
  fields,
  buttonLabel,
  pendingLabel,
  description,
  focusLabel,
}: {
  kind: "review_aid" | "readiness_summary" | "schedule_conflict_explanation";
  fields?: Record<string, string>;
  buttonLabel: string;
  pendingLabel: string;
  description: string;
  focusLabel?: string;
}) {
  const fetcher = useFetcher<ContextActionResponse>();
  const pending = fetcher.state !== "idle";

  return (
    <div className="stack">
      <fetcher.Form method="post" action="/ai/context" className="stack">
        <input type="hidden" name="kind" value={kind} />
        {Object.entries(fields ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {focusLabel ? (
          <label className="label">
            {focusLabel}
            <input
              className="field"
              type="text"
              name="focus"
              maxLength={500}
              placeholder="Optional — leave blank for a complete overview"
            />
          </label>
        ) : null}
        <p className="help">{description}</p>
        <Button type="submit" disabled={pending}>
          <Sparkles aria-hidden size={14} />
          {pending ? pendingLabel : buttonLabel}
        </Button>
      </fetcher.Form>
      {fetcher.data?.ok ? (
        <ContextualAiResultPanel result={fetcher.data.result} />
      ) : fetcher.data ? (
        <p className="status danger" role="alert">
          {fetcher.data.error}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewAidAction({ assignmentId }: { assignmentId: string }) {
  return (
    <ContextAction
      kind="review_aid"
      fields={{ assignmentId }}
      buttonLabel="Generate advisory review aid"
      pendingLabel="Comparing source with rubric…"
      focusLabel="Review focus"
      description="AI can map the submission to this rubric and identify missing evidence. It cannot score, submit or change your review."
    />
  );
}

export function ReadinessSummaryAction() {
  return (
    <ContextAction
      kind="readiness_summary"
      buttonLabel="Summarise readiness blockers"
      pendingLabel="Inspecting readiness evidence…"
      focusLabel="Operational focus"
      description="AI prioritisation is advisory and cites the current readiness snapshot. No task or message is created."
    />
  );
}

export type ReminderDeliveryOptions = {
  templates: Array<{
    id: string;
    templateId: string;
    name: string;
    versionNumber: number;
    subject: string;
  }>;
  sender: string | null;
  configured: boolean;
  problem: string | null;
};

export function ReminderDraftAction({
  options,
}: {
  options: ReminderDeliveryOptions;
}) {
  const fetcher = useFetcher<ContextActionResponse>();
  const pending = fetcher.state !== "idle";
  return (
    <div className="stack">
      <fetcher.Form method="post" action="/ai/context" className="stack">
        <input type="hidden" name="kind" value="reminder_send_preview" />
        <label className="label">
          Targeted audience
          <select className="select" name="cohort" required>
            <option value="incomplete_speakers">
              Speakers with incomplete tasks
            </option>
            <option value="overdue_speaker_tasks">
              Speakers with overdue tasks
            </option>
          </select>
        </label>
        <label className="label">
          Approved reminder foundation
          <select
            className="select command-template-select"
            name="baseTemplateVersionId"
            required
            disabled={!options.templates.length}
          >
            {options.templates.map((template) => (
              <option value={template.id} key={template.id}>
                {template.name} · v{template.versionNumber} · {template.subject}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Message purpose
          <textarea
            className="textarea"
            name="objective"
            minLength={3}
            maxLength={500}
            rows={4}
            required
            defaultValue="Explain the outstanding task and give the speaker a clear next step without inventing a deadline."
          />
        </label>
        <label className="label">
          Delivery classification
          <select className="select" name="deliveryKind" required>
            <option value="transactional">Transactional task reminder</option>
            <option value="optional">Optional email</option>
          </select>
        </label>
        <p className="help">
          AI drafts the copy. Program Cue then saves an immutable draft
          template, resolves every recipient and suppression, and stops at an
          exact preview. Nothing is queued until a separate explicit approval.
        </p>
        {!options.configured ? (
          <p className="status danger" role="alert">
            {options.problem}
          </p>
        ) : (
          <p className="help">Delivery sender: {options.sender}</p>
        )}
        <Button type="submit" disabled={pending || !options.configured}>
          <Sparkles aria-hidden size={14} />
          {pending
            ? "Drafting and resolving recipients…"
            : "Draft exact reminder preview"}
        </Button>
      </fetcher.Form>
      {fetcher.data?.ok ? (
        <>
          <ContextualAiResultPanel result={fetcher.data.result} />
          {fetcher.data.proposal ? (
            <ProposalApproval proposal={fetcher.data.proposal} />
          ) : null}
        </>
      ) : fetcher.data ? (
        <p className="status danger" role="alert">
          {fetcher.data.error}
        </p>
      ) : null}
    </div>
  );
}

export function ScheduleConflictExplanationAction({
  conflictId,
}: {
  conflictId: string;
}) {
  return (
    <ContextAction
      kind="schedule_conflict_explanation"
      fields={{ conflictId }}
      buttonLabel="Explain this conflict"
      pendingLabel="Inspecting conflict policy…"
      description="AI explains this recorded conflict and its governing policy. It cannot move, resolve or publish sessions."
    />
  );
}

export function SessionCopyAction({ sessionId }: { sessionId: string }) {
  const fetcher = useFetcher<ContextActionResponse>();
  const pending = fetcher.state !== "idle";
  return (
    <div className="stack mb">
      <fetcher.Form method="post" action="/ai/context">
        <input type="hidden" name="kind" value="session_copy" />
        <input type="hidden" name="sessionId" value={sessionId} />
        <p className="help">
          Draft editable public copy from this session’s authorised record. AI
          cannot change or publish the session.
        </p>
        <Button type="submit" disabled={pending}>
          <Sparkles aria-hidden size={14} />
          {pending ? "Drafting session copy…" : "Draft public session copy"}
        </Button>
      </fetcher.Form>
      {fetcher.data?.ok ? (
        <ContextualAiResultPanel result={fetcher.data.result} />
      ) : fetcher.data ? (
        <p className="status danger" role="alert">
          {fetcher.data.error}
        </p>
      ) : null}
    </div>
  );
}
