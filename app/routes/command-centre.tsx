import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { Button, ButtonLink } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState } from "~/components/ui/states";
import { StatusBadge } from "~/components/ui/status-badge";
import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { AiProviderSettingsService } from "~/modules/ai/ai-provider.server";
import type {
  AiProposalPreview,
  ContextualAiResult,
} from "~/modules/ai/ai-types";
import {
  ContextualAiResultPanel,
  ProposalApproval,
} from "~/modules/ai/assistant-result-panel";
import type { ReminderDeliveryOptions } from "~/modules/ai/contextual-ai-actions";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { groupProgrammeSetupSteps } from "~/modules/readiness/programme-workflow-phases";
import {
  type DeliveryChannel,
  ReadinessService,
} from "~/modules/readiness/readiness-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  type RealtimeTransportStatus,
  subscribeToEventChanges,
} from "~/platform/realtime/realtime-client";
import type { Route } from "./+types/command-centre";

export const meta: Route.MetaFunction = () => [
  { title: "Command Centre · Program Cue" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  await ensureDemoEvaluationData(env);
  const [snapshot, reminderOptions, aiReadiness] = await Promise.all([
    new ReadinessService(env).getCommandCentre(viewer),
    new AiAssistantService(env).reminderDeliveryOptions(viewer),
    new AiProviderSettingsService(env).readiness(viewer),
  ]);
  return { ...snapshot, reminderOptions, aiReadiness };
}

type ContextActionResponse =
  | {
      ok: true;
      result: ContextualAiResult;
      proposal: AiProposalPreview | null;
    }
  | { ok: false; error: string };

const DEFAULT_REMINDER_PURPOSE =
  "Explain the outstanding task and give the speaker a clear next step without inventing a deadline.";

function AutoRefresh({ eventId, cursor }: { eventId: string; cursor: number }) {
  const revalidator = useRevalidator();
  const [transport, setTransport] =
    useState<RealtimeTransportStatus>("connecting");
  useEffect(() => {
    const url = `/admin/events/${encodeURIComponent(eventId)}/changes`;
    return subscribeToEventChanges({
      liveUrl: url,
      pollUrl: url,
      initialCursor: cursor,
      onInvalidate: () => revalidator.revalidate(),
      onError: (error) =>
        console.warn("Command Centre realtime transport error.", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      onStatusChange: setTransport,
    });
  }, [cursor, eventId, revalidator]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [revalidator]);

  return (
    <span
      className={`status ${transport === "unavailable" ? "danger" : transport === "polling" ? "warning" : "info"}`}
      role="status"
      aria-live="polite"
    >
      <RefreshCw
        aria-hidden
        size={13}
        className={revalidator.state !== "idle" ? "pc-spin" : undefined}
      />
      {revalidator.state !== "idle"
        ? "Refreshing"
        : transport === "live"
          ? "Live"
          : transport === "polling"
            ? "Polling"
            : transport === "unavailable"
              ? "Updates unavailable"
              : "Connecting"}
    </span>
  );
}

/* 100% is silence. Below it the ramp has to be monotonic in severity or the
   page misreports itself: the previous bands painted 33% gold and 50% copper,
   so the workflow further behind looked calmer than the one ahead of it. */
function progressTone(score: number) {
  if (score >= 100) return "quiet";
  if (score >= 67) return "";
  return score >= 34 ? "amber" : "red";
}

function deliveryChannelLabel(channel: DeliveryChannel) {
  switch (channel) {
    case "email":
      return "Email";
    case "sms":
      return "SMS";
    case "push":
      return "Push";
    case "calendar":
      return "Calendar";
    default:
      throw new Error(`Unsupported delivery channel: ${String(channel)}`);
  }
}

/* Sessions arrive in start order, so a day break is simply the point where the
   event-local calendar date changes. Grouping is what stops the same date
   being restated on every row. */
function groupUpcomingByDay(
  sessions: Route.ComponentProps["loaderData"]["upcoming"],
  timeZone: string,
) {
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const dayLabel = new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
  const days: Array<{
    key: string;
    label: string;
    sessions: typeof sessions;
  }> = [];
  for (const session of sessions) {
    const startsAt = new Date(session.startsAt * 1_000);
    const key = dayKey.format(startsAt);
    const current = days.at(-1);
    if (current?.key === key) current.sessions.push(session);
    else
      days.push({ key, label: dayLabel.format(startsAt), sessions: [session] });
  }
  return days;
}

function CommandReminderComposer({
  options,
}: {
  options: ReminderDeliveryOptions;
}) {
  const fetcher = useFetcher<ContextActionResponse>();
  const pending = fetcher.state !== "idle";
  const canDraft = options.configured;
  return (
    <div className="command-composer">
      <div className="command-panel-head">
        <h2 className="command-section-head">Targeted reminder</h2>
        <span className="command-qualifier">Preview first</span>
      </div>
      <fetcher.Form
        method="post"
        action="/ai/context"
        className="command-composer-form"
      >
        <input type="hidden" name="kind" value="reminder_send_preview" />
        <label className="label">
          Audience
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
          Delivery
          <select className="select" name="deliveryKind" required>
            <option value="transactional">Transactional task reminder</option>
            <option value="optional">Optional email</option>
          </select>
        </label>
        {/* Both fields are required and both shape what the model is told to
            do, so neither sits behind a disclosure: an operator could otherwise
            queue a reminder without ever seeing which approved foundation it
            was built from. The disclosure also bought no height — the column
            has more slack than the two fields consume. */}
        <label className="label">
          Approved reminder foundation
          <select
            className="select command-template-select"
            name="baseTemplateVersionId"
            required
            disabled={!options.templates.length}
          >
            {options.templates.length ? (
              options.templates.map((template) => (
                <option value={template.id} key={template.id}>
                  {template.name} · v{template.versionNumber}
                </option>
              ))
            ) : (
              <option value="">No approved reminder template yet</option>
            )}
          </select>
        </label>
        <label className="label">
          Message purpose
          <textarea
            className="textarea"
            name="objective"
            minLength={3}
            maxLength={500}
            rows={3}
            required
            defaultValue={DEFAULT_REMINDER_PURPOSE}
          />
        </label>
        <div className="command-composer-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={!canDraft}
            pending={pending}
            pendingLabel="Drafting preview…"
          >
            <Sparkles aria-hidden size={14} />
            Draft preview
          </Button>
        </div>
        {canDraft ? null : (
          <p className="command-notice" role="status">
            <AlertCircle aria-hidden size={15} />
            <span>
              {options.problem ??
                "Drafting is unavailable until reminder delivery is configured."}
            </span>
          </p>
        )}
      </fetcher.Form>
      {fetcher.data?.ok ? (
        <>
          <ContextualAiResultPanel result={fetcher.data.result} />
          {fetcher.data.proposal ? (
            <ProposalApproval proposal={fetcher.data.proposal} />
          ) : null}
        </>
      ) : fetcher.data ? (
        <p className="command-notice" role="alert">
          <AlertCircle aria-hidden size={15} />
          <span>{fetcher.data.error}</span>
        </p>
      ) : null}
    </div>
  );
}

function CommandReadinessCommand() {
  const fetcher = useFetcher<ContextActionResponse>();
  const pending = fetcher.state !== "idle";
  return (
    <div className="command-advisor">
      <div className="command-panel-head">
        <h2 className="command-section-head">Readiness summary</h2>
        <span className="command-qualifier">Advisory</span>
      </div>
      <fetcher.Form method="post" action="/ai/context" className="stack">
        <input type="hidden" name="kind" value="readiness_summary" />
        <label className="label">
          Operational focus
          <input
            className="field"
            type="text"
            name="focus"
            maxLength={500}
            placeholder="Optional — leave blank for a complete overview"
          />
        </label>
        <p className="help">
          AI prioritisation is advisory and cites the current readiness
          snapshot. No task or message is created.
        </p>
        <Button
          type="submit"
          pending={pending}
          pendingLabel="Inspecting readiness…"
        >
          <Sparkles aria-hidden size={14} />
          Summarise readiness blockers
        </Button>
      </fetcher.Form>
      {fetcher.data?.ok ? (
        <ContextualAiResultPanel result={fetcher.data.result} />
      ) : fetcher.data ? (
        <p className="command-notice" role="alert">
          <AlertCircle aria-hidden size={15} />
          <span>{fetcher.data.error}</span>
        </p>
      ) : null}
    </div>
  );
}

const blockerGroupLabels = {
  must_resolve: "Must resolve",
  due_soon: "Due soon",
  waiting: "Waiting or follow-up",
  plan_next: "Plan next",
} as const;

export default function CommandCentre({ loaderData }: Route.ComponentProps) {
  const completedSetupSteps = loaderData.setupGuide.filter(
    (step) => step.complete,
  ).length;
  const workflowPhases = groupProgrammeSetupSteps(loaderData.setupGuide);
  const completedWorkflowPhases = workflowPhases.filter(
    (phase) => phase.complete,
  ).length;
  const readinessLabel =
    loaderData.readiness.status === "ready"
      ? "Ready"
      : loaderData.readiness.status === "on_track"
        ? "On track"
        : loaderData.readiness.status === "needs_attention"
          ? "Needs attention"
          : "At risk";
  const readinessConditionLabel = [
    loaderData.readiness.criticalConditionCount
      ? `${loaderData.readiness.criticalConditionCount} critical condition${loaderData.readiness.criticalConditionCount === 1 ? "" : "s"}`
      : null,
    loaderData.readiness.warningConditionCount
      ? `${loaderData.readiness.warningConditionCount} warning condition${loaderData.readiness.warningConditionCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const blockerCount = loaderData.blockers.length;
  const remainingBlockers = loaderData.blockers.filter(
    (blocker) => blocker.key !== loaderData.topAction?.key,
  );
  const blockerGroups = Object.entries(blockerGroupLabels)
    .map(([key, label]) => ({
      key: key as keyof typeof blockerGroupLabels,
      label,
      blockers: remainingBlockers.filter((blocker) => blocker.group === key),
    }))
    .filter((group) => group.blockers.length > 0);
  /* The panel exists to expose the workflows that are not ready. In domain
     order the two zeros landed in the middle of six rows and had to be hunted
     for. */
  const workflows = [...loaderData.workflows].sort((a, b) => a.score - b.score);
  const upcomingDays = groupUpcomingByDay(
    loaderData.upcoming,
    loaderData.eventTimezone,
  );
  const deliveryChannels = loaderData.deliveryHealth;

  return (
    <div className="command-page">
      <PageHeader
        className="command-page-head"
        title="Command Centre"
        actions={
          <>
            <AutoRefresh
              eventId={loaderData.eventId}
              cursor={loaderData.cursor}
            />
            <ButtonLink to="/admin/event">Event settings</ButtonLink>
          </>
        }
      />

      {completedSetupSteps < loaderData.setupGuide.length ? (
        <section
          className="command-region"
          id="command-setup"
          aria-labelledby="command-setup-title"
        >
          <h2 className="command-section-head" id="command-setup-title">
            Programme setup · {completedWorkflowPhases} of{" "}
            {workflowPhases.length} phases ready
          </h2>
          <div className="command-workflow-phases">
            {workflowPhases.map((phase, index) => (
              <section className="command-workflow-phase" key={phase.key}>
                <div className="command-workflow-phase-heading">
                  <StatusBadge tone={phase.complete ? "success" : "info"}>
                    <span aria-hidden>{index + 1}</span>
                    <span className="sr-only">
                      Phase {index + 1} {phase.complete ? "ready" : "not ready"}
                    </span>
                  </StatusBadge>
                  <h3>{phase.label}</h3>
                </div>
                <div className="command-workflow-steps">
                  {phase.steps.map((step) => (
                    <Link
                      className="command-workflow-step"
                      to={step.href}
                      key={step.key}
                    >
                      {step.complete ? (
                        <CheckCircle2
                          aria-label="Complete"
                          className="tone-success"
                          size={16}
                        />
                      ) : (
                        <Clock3 aria-label="Not complete" size={16} />
                      )}
                      <span>{step.label}</span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : null}

      <section className="command-region command-hero" aria-label="Readiness">
        <section
          className="command-score"
          data-state={loaderData.readiness.status}
        >
          <h2 className="command-section-head command-score-kicker">
            Overall readiness
          </h2>
          <p className="command-score-reading">
            <strong className="pc-num">
              {loaderData.readiness.percentage}
              <span className="command-score-unit">%</span>
            </strong>
            <span className="command-score-state">{readinessLabel}</span>
          </p>
          {readinessConditionLabel ? (
            <p className="command-score-condition">{readinessConditionLabel}</p>
          ) : null}
          <div className="command-score-track" aria-hidden>
            <span style={{ width: `${loaderData.readiness.percentage}%` }} />
          </div>
          <p className="command-score-caption">
            Equal weight across {loaderData.workflows.length} workflows, capped
            by programme setup.
          </p>
          <details className="command-score-method">
            <summary>How this is scored</summary>
            <p>{loaderData.readiness.explanation}</p>
            <p>
              Task readiness inside a workflow is{" "}
              <a href="/admin/tasks#readiness-weighting">weighted by impact</a>.
            </p>
          </details>
        </section>

        <section className="command-queue" id="action-queue">
          <div className="command-panel-head command-queue-head">
            <h2 className="command-section-head">Action queue</h2>
            <p>
              {blockerCount}
              {blockerCount === 1 ? " condition" : " conditions"}
            </p>
          </div>
          {blockerCount ? (
            <div className="command-blockers">
              {loaderData.topAction ? (
                <Link
                  className={`command-top-action ${loaderData.topAction.severity === "danger" ? "is-danger" : "is-warning"}`}
                  to={loaderData.topAction.href}
                >
                  <span className="command-top-action-kicker">
                    Do this next
                  </span>
                  <strong>{loaderData.topAction.action}</strong>
                  <small>
                    {loaderData.topAction.label} · {loaderData.topAction.count}{" "}
                    affected
                  </small>
                  <ChevronRight aria-hidden size={18} />
                </Link>
              ) : null}
              {blockerGroups.map((group) => (
                <section className="command-blocker-group" key={group.key}>
                  <h3>{group.label}</h3>
                  {group.blockers.map((blocker) => (
                    <Link
                      className={`command-blocker ${blocker.severity === "danger" ? "is-danger" : "is-warning"}`}
                      to={blocker.href}
                      key={blocker.key}
                    >
                      {blocker.severity === "danger" ? (
                        <AlertTriangle aria-label="Critical" size={18} />
                      ) : (
                        <AlertCircle aria-label="Needs attention" size={18} />
                      )}
                      <span className="command-blocker-copy">
                        <strong>
                          {blocker.label}
                          <b className="pc-num command-blocker-count">
                            {blocker.count}
                          </b>
                        </strong>
                        <small>{blocker.action}</small>
                      </span>
                      <ChevronRight
                        aria-hidden
                        className="command-blocker-go"
                        size={16}
                      />
                    </Link>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No blockers"
              description="No declared blockers in the current records."
              tone="positive"
            />
          )}
        </section>
      </section>

      <section
        className="command-region"
        id="command-workflows"
        aria-labelledby="command-workflows-title"
      >
        <h2 className="command-section-head" id="command-workflows-title">
          Workflows
        </h2>
        <div className="command-workflow-list">
          {workflows.map((workflow) => (
            <Link
              className="command-workflow-row"
              to={workflow.href}
              key={workflow.key}
              aria-label={`${workflow.label}: ${workflow.score}% ready`}
            >
              <strong>{workflow.label}</strong>
              <small className="command-workflow-detail">
                {workflow.detail}
              </small>
              <div
                className={`command-meter ${progressTone(workflow.score)}${workflow.score === 0 ? " is-zero" : ""}`}
                aria-hidden
              >
                <span style={{ width: `${workflow.score}%` }} />
              </div>
              <b className="pc-num">{workflow.score}%</b>
            </Link>
          ))}
        </div>
      </section>

      <section
        className="command-region command-support"
        id="command-assistants"
        aria-label="Assistants and delivery"
      >
        {loaderData.aiReadiness.configured ? (
          <CommandReminderComposer options={loaderData.reminderOptions} />
        ) : (
          <section className="command-ai-unavailable">
            <div className="command-panel-head">
              <h2 className="command-section-head">AI assistance</h2>
              <span className="command-qualifier">Optional</span>
            </div>
            <p>{loaderData.aiReadiness.problem}</p>
            <ButtonLink to="/admin/assistant">Configure AI provider</ButtonLink>
          </section>
        )}
        <div className="command-assist-side">
          {loaderData.aiReadiness.configured ? (
            <CommandReadinessCommand />
          ) : null}
          <section className="command-delivery">
            <div className="command-panel-head">
              <h2 className="command-band-head">Delivery</h2>
              <Link className="command-text-link" to="/admin/communications">
                Logs
              </Link>
            </div>
            {deliveryChannels.length ? (
              <section
                className="table-wrap"
                aria-label="Delivery health by channel"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
                tabIndex={0}
              >
                <table className="jobs command-health-table">
                  <thead>
                    <tr>
                      <th scope="col">Channel</th>
                      <th scope="col">Tracked</th>
                      <th scope="col">Accepted or delivered rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveryChannels.map((channel) => (
                      <tr key={channel.channel}>
                        <th scope="row">
                          {deliveryChannelLabel(channel.channel)}
                        </th>
                        <td className="pc-num">
                          {channel.total.toLocaleString()}
                        </td>
                        <td>
                          <strong
                            className={`pc-num ${
                              channel.percentage === 100
                                ? "tone-success"
                                : "tone-warning"
                            }`}
                          >
                            {channel.percentage}%
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : (
              <EmptyState
                title="No delivery activity"
                description="Nothing has been sent for this event yet."
                icon={Send}
              />
            )}
          </section>
        </div>
      </section>

      <section
        className="command-region command-activity"
        id="command-activity"
        aria-label="Schedule and operations"
      >
        <section className="command-agenda">
          <div className="command-panel-head">
            <h2 className="command-section-head">Upcoming sessions</h2>
            <Link className="command-text-link" to="/admin/schedule">
              Open schedule
            </Link>
          </div>
          {upcomingDays.length ? (
            <div className="command-session-list">
              {upcomingDays.map((day, index) => (
                <Fragment key={day.key}>
                  <p className="command-session-day">
                    <span>{day.label}</span>
                    {index === 0 ? (
                      <span className="command-session-zone">
                        Times in {loaderData.eventTimezone}
                      </span>
                    ) : null}
                  </p>
                  {day.sessions.map((session) => (
                    <Link
                      className="command-session-row command-agenda-link"
                      to={`/admin/schedule?session=${encodeURIComponent(session.id)}`}
                      key={session.id}
                    >
                      <EventDateTime
                        epochSeconds={session.startsAt}
                        timeZone={loaderData.eventTimezone}
                        className="command-session-time"
                        focusable={false}
                      >
                        <span className="pc-num">
                          {new Intl.DateTimeFormat("en", {
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: loaderData.eventTimezone,
                          }).format(new Date(session.startsAt * 1_000))}
                        </span>
                      </EventDateTime>
                      <span className="command-session-title">
                        {session.title}
                      </span>
                      <small className="command-session-room">
                        {session.room}
                      </small>
                      {session.status === "attention_required" ? (
                        <span className="command-session-readiness">
                          <StatusBadge tone="warning">Attention</StatusBadge>
                          <small>{session.riskReason}</small>
                        </span>
                      ) : (
                        <span className="sr-only">No blockers found</span>
                      )}
                    </Link>
                  ))}
                </Fragment>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No upcoming sessions"
              description="No future sessions exist in the current published schedule."
              icon={Clock3}
            />
          )}
        </section>

        <section className="command-ops">
          <div className="command-panel-head">
            <h2 className="command-section-head">Operations</h2>
            <Link className="command-text-link" to="/admin/operations">
              View all
            </Link>
          </div>
          {loaderData.operations.length ? (
            <ul className="command-ops-list">
              {loaderData.operations.map((operation) => (
                <li key={operation.id}>
                  <Link
                    className="command-ops-row"
                    to={`/admin/operations?operation=${encodeURIComponent(operation.id)}`}
                  >
                    <span className="command-ops-type">
                      {operationTypeLabel(operation.type)}
                    </span>
                    <DomainStatusBadge
                      domain="operation"
                      status={operation.status}
                    />
                    {operation.total > 0 ? (
                      <span className="command-ops-progress">
                        {percentForOperation(
                          operation.completed,
                          operation.total,
                        ) > 0 ? (
                          <span className="command-meter" aria-hidden>
                            <span
                              style={{
                                width: `${percentForOperation(operation.completed, operation.total)}%`,
                              }}
                            />
                          </span>
                        ) : null}
                        <small className="subtle pc-num">
                          {operation.completed} of {operation.total}
                        </small>
                      </span>
                    ) : (
                      <span className="command-ops-idle">—</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Nothing running"
              description="Bulk sends, publications and provider work appear here while they are in progress."
              icon={Activity}
            />
          )}
        </section>
      </section>
    </div>
  );
}

function percentForOperation(completed: number, total: number) {
  return total > 0
    ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
    : 0;
}

function operationTypeLabel(type: string) {
  const label = type.replaceAll(/[._]+/g, " ").trim();
  return label ? label[0].toUpperCase() + label.slice(1) : type;
}
