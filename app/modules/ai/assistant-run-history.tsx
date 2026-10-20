import { ButtonLink } from "~/components/ui/button";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { AssistantRunReport } from "./ai-run-report.server";
import { EvidenceList } from "./assistant-result-panel";

export function AssistantRunHistory({ runs }: { runs: AssistantRunReport[] }) {
  if (!runs.length) return null;
  return (
    <section
      className="pc-assist-history"
      aria-label="Previous assistant requests"
    >
      <h2>Previous requests</h2>
      {runs.map((run) => (
        <details className="pc-assist-history-entry" key={run.runId}>
          <summary>
            <strong>{run.requestLabel}</strong>
            <span className="pc-assist-history-meta">
              <EventDateTime
                epochSeconds={run.startedAt}
                timeZone={run.timeZone}
                focusable={false}
              />
              <span>
                {run.demonstrationOnly ? "Demonstration · " : ""}
                {run.outcome}
              </span>
            </span>
          </summary>
          <div className="stack">
            {run.answer ? (
              <p className="pc-assist-answer">{run.answer}</p>
            ) : (
              <p className="help">
                No accepted answer was retained for this request.
              </p>
            )}
            <EvidenceList evidence={run.evidence} compact />
            {run.proposals
              .filter((proposal) => proposal.outcome !== "Replaced")
              .map((proposal) => (
                <div className="pc-assist-history-action" key={proposal.id}>
                  <strong>{proposal.title}</strong>
                  <p>{proposal.outcome}</p>
                  {proposal.settlement === "pending" ? (
                    <p>
                      The task was created. Retry the approval to finish
                      recording the assistant result; the saved task will be
                      reused.
                    </p>
                  ) : null}
                  {proposal.taskId ? (
                    <>
                      <p className="help">
                        Creating this task does not resolve the underlying work.
                      </p>
                      <ButtonLink
                        size="small"
                        to={`/admin/tasks?task=${encodeURIComponent(proposal.taskId)}`}
                      >
                        Open task
                      </ButtonLink>
                    </>
                  ) : proposal.outcome === "Awaiting approval" ||
                    proposal.outcome === "Action failed" ||
                    proposal.outcome === "Approval recorded" ? (
                    <ButtonLink size="small" to="#assistant-approvals">
                      Review proposal
                    </ButtonLink>
                  ) : null}
                  {proposal.failure ? <p>{proposal.failure}</p> : null}
                </div>
              ))}
            <details className="pc-disclosure">
              <summary>AI details and audit trail</summary>
              <p className="help">
                Response generation: {run.status} · {run.provider} · {run.model}
                {run.measurements
                  ? ` · ${run.measurements.totals.callCount} model calls · ${(run.measurements.durationMs / 1000).toFixed(1)}s`
                  : " · measurements unavailable"}
              </p>
              {run.measurements ? (
                <p className="help">
                  Input tokens:{" "}
                  {run.measurements.totals.inputTokens ?? "unknown"} · Output
                  tokens: {run.measurements.totals.outputTokens ?? "unknown"} ·
                  Estimated inference cost:{" "}
                  {run.measurements.totals.estimatedCostUsd === null
                    ? "unknown"
                    : `$${run.measurements.totals.estimatedCostUsd.toFixed(6)}`}
                </p>
              ) : null}
              <p className="help">
                Generation, approval and execution are separate outcomes.
                Estimates use recorded dated rates and exclude other application
                costs. Missing usage and cost remain unknown.
              </p>
              <pre
                className="pc-assist-audit"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The retained audit is scrollable and must support keyboard scrolling.
                tabIndex={0}
              >
                {JSON.stringify(run, null, 2)}
              </pre>
            </details>
          </div>
        </details>
      ))}
    </section>
  );
}
