import { IMPACT_WEIGHTS } from "~/modules/readiness/readiness-rules";

const IMPACT_ORDER = ["critical", "high", "medium", "low"] as const;

const IMPACT_LABELS: Record<(typeof IMPACT_ORDER)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function ReadinessWeightingCard() {
  const headingId = "readiness-weighting-heading";
  return (
    <section className="card pad" aria-labelledby={headingId}>
      <div className="card-title">
        <h2 id={headingId}>Readiness rules and weighting</h2>
      </div>
      <p className="subtle pc-weighting-intro">
        A task contributes to readiness in proportion to its impact, so
        completing one critical requirement moves the score as far as four low
        ones.
      </p>
      <table className="pc-weighting-table">
        <thead>
          <tr>
            <th scope="col">Impact</th>
            <th scope="col">Weight</th>
          </tr>
        </thead>
        <tbody>
          {IMPACT_ORDER.map((impact) => (
            <tr key={impact}>
              <th scope="row">
                <span className={`impact ${impact}`}>
                  {IMPACT_LABELS[impact]}
                </span>
              </th>
              <td className="pc-num">{IMPACT_WEIGHTS[impact]}×</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subtle pc-weighting-note">
        Each task also carries its own completion percentage. Readiness is the
        weighted average of those percentages, not the count of finished tasks.
        A waived task counts as complete.
      </p>
    </section>
  );
}

export function ReadinessWeightingNote({
  workflowCount,
}: {
  workflowCount: number;
}) {
  return (
    <p className="command-score-note">
      Equal weighting across {workflowCount} workflows. Task readiness inside
      them is <a href="/admin/tasks#readiness-weighting">weighted by impact</a>.
    </p>
  );
}
