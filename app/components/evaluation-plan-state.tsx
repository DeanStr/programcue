import { useEffect, useState } from "react";
import { Form, Link, useLocation } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import {
  AcceptedSpeakerInvitationsPanel,
  EvaluationModerationPanel,
  EvaluationProgressionPanel,
  EvaluationSessionQueue,
  EvaluationSubmissionQueue,
  EvaluationUnifiedResults,
} from "~/components/evaluation-admin-queue-panels";
import { EvaluationDiscussionPanel } from "~/components/evaluation-discussion-panel";

import { EvaluationMetrics } from "~/components/evaluation-metrics";
import { EvaluationReviewCyclePanel } from "~/components/evaluation-review-cycle-panel";
import { EvaluationRoundsPanel } from "~/components/evaluation-rounds-panel";
import { RubricFields } from "~/components/evaluation-rubric-fields";
import { EvaluationTeamsPanel } from "~/components/evaluation-teams-panel";
import { AdminPageSection } from "~/components/ui/admin-page-sections";

const defaultRubric = [
  {
    name: "Relevance",
    description: "Fit for this event and audience",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
  },
  {
    name: "Originality",
    description: "Distinctive perspective",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
  },
  {
    name: "Content quality",
    description: "Clarity and substance",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
  },
  {
    name: "Practical application",
    description: "Useful attendee outcomes",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
  },
  {
    name: "Expertise",
    description: "Credible speaker experience",
    inputType: "scale_5",
    weightPercent: 10,
    required: true,
  },
] as const;

function ReviewerAiSettingCard() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  if (
    !loaderData.canManageEvaluationAccess ||
    !loaderData.aiReviewAssessmentsSupported
  )
    return null;
  return (
    <section className="card pad pc-eval-setting">
      <h2>Reviewer AI suggestions</h2>
      <p className="subtle">
        Event opt-in. Reviewers must request suggestions after saving an initial
        rubric response. Suggestions remain advisory and cannot submit a review
        or enter aggregate scores by themselves.
      </p>
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="update-reviewer-ai-setting" />
        <input
          type="hidden"
          name="revision"
          value={loaderData.reviewerAiSetting.revision}
        />
        <label className="validation-item">
          <input
            type="checkbox"
            name="enabled"
            value="true"
            defaultChecked={loaderData.reviewerAiSetting.enabled}
          />
          <span className="reviewer-ai-setting-copy">
            <strong>Allow reviewer-requested AI suggestions</strong>
            <span>
              Sends reviewer-visible fields from the immutable source snapshot
              and the current scorecard to the organisation’s configured AI
              provider.
            </span>
          </span>
        </label>
        <button
          type="submit"
          className="btn"
          disabled={navigation.state !== "idle"}
        >
          Save reviewer AI setting
        </button>
      </Form>
    </section>
  );
}

export function EvaluationPlanState() {
  const { loaderData, navigation } = useEvaluationAdminModel();
  return !loaderData.plan ? (
    <AdminPageSection
      id="evaluation-setup"
      label="Create the evaluation plan"
      description="First review round, rubric and decision authority"
      defaultExpandedOnMobile
    >
      <section className="card pad">
        <h2>Create the evaluation plan</h2>
        <p className="subtle">
          Configure the first review round and its weighted rubric. Active round
          rubrics become protected once assignments exist.
        </p>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="create-plan" />
          <label className="label">
            Plan name
            <input
              className="input"
              name="planName"
              defaultValue="Programme committee review"
              required
            />
          </label>
          <label className="label">
            First round name
            <input
              className="input"
              name="roundName"
              defaultValue="Initial review"
              required
            />
          </label>
          <div className="grid grid-2">
            <label className="label">
              Opens ({loaderData.eventTimezone})
              <input
                className="input pc-eval-datetime"
                type="datetime-local"
                name="roundOpensAt"
              />
            </label>
            <label className="label">
              Closes ({loaderData.eventTimezone})
              <input
                className="input pc-eval-datetime"
                type="datetime-local"
                name="roundClosesAt"
              />
            </label>
          </div>
          <label className="validation-item">
            <input type="checkbox" name="anonymous" value="true" />
            <span>
              <strong>Hide author and co-author identity</strong>
              Speaker names and email addresses are omitted from reviewer
              workspaces for this round. Administrator-only form answers are
              always excluded, whether identity blinding is on or off.
            </span>
          </label>
          {loaderData.canManageEvaluationAccess ? (
            <label className="label">
              Final decision authority
              <select className="select" name="decisionRole">
                <option value="administrator">Owners and administrators</option>
                <option value="committee_chair">
                  Owners, administrators and committee chairs
                </option>
              </select>
            </label>
          ) : (
            <div className="validation-item">
              <input type="hidden" name="decisionRole" value="administrator" />
              <strong>Final decisions remain administrator-only</strong>
              <span>
                An owner or administrator must explicitly grant final decision
                authority to committee chairs.
              </span>
            </div>
          )}
          <RubricFields
            criteria={defaultRubric.map((criterion) => ({
              ...criterion,
              description: criterion.description,
            }))}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={navigation.state !== "idle"}
          >
            Create review plan
          </button>
        </Form>
      </section>
    </AdminPageSection>
  ) : (
    <EvaluationAdminViews />
  );
}

type EvaluationAdminView = "results" | "assignments" | "setup";

const EVALUATION_VIEW_STORAGE_KEY = "pc-eval-admin-view";

function isEvaluationAdminView(
  value: string | null,
): value is EvaluationAdminView {
  return value === "results" || value === "assignments" || value === "setup";
}

function viewFromHash(hash: string): EvaluationAdminView {
  const id = hash.replace(/^#/, "");
  if (
    id === "evaluation-assignments" ||
    id === "evaluation-proposals" ||
    id === "evaluation-sessions" ||
    id.startsWith("review-submission-")
  ) {
    return "assignments";
  }
  if (
    id === "evaluation-setup" ||
    id === "evaluation-access" ||
    id === "evaluation-rounds" ||
    id === "evaluation-moderation"
  ) {
    return "setup";
  }
  return "results";
}

function EvaluationAdminViews() {
  const location = useLocation();
  const [storedView, setStoredView] = useState<EvaluationAdminView>("results");
  const [discussionOpen, setDiscussionOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const discussionTargeted =
      location.hash === "#evaluation-discussion" ||
      params.has("submission") ||
      params.has("session");
    setDiscussionOpen(discussionTargeted);
    if (location.hash) {
      const next = viewFromHash(location.hash);
      setStoredView(next);
      sessionStorage.setItem(EVALUATION_VIEW_STORAGE_KEY, next);
      return;
    }
    const stored = sessionStorage.getItem(EVALUATION_VIEW_STORAGE_KEY);
    if (isEvaluationAdminView(stored)) setStoredView(stored);
  }, [location.hash, location.search]);

  const view = location.hash ? viewFromHash(location.hash) : storedView;

  useEffect(() => {
    const id = location.hash.replace(/^#/, "");
    if (!id.startsWith("review-submission-")) return;
    document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [location.hash]);

  return (
    <>
      <EvaluationMetrics />
      <nav className="pc-eval-switcher" aria-label="Evaluation views">
        {(
          [
            ["results", "Results", "evaluation-results"],
            ["assignments", "Assignments", "evaluation-assignments"],
            ["setup", "Setup", "evaluation-setup"],
          ] as const
        ).map(([key, label, hash]) => (
          <Link
            key={key}
            to={{ search: location.search, hash }}
            className={view === key ? "is-current" : undefined}
            aria-current={view === key ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      {view === "results" ? (
        <div id="evaluation-results" className="pc-eval-view">
          <EvaluationUnifiedResults />
          <details
            className="pc-eval-discussion-disclosure"
            open={discussionOpen}
            onToggle={(event) => setDiscussionOpen(event.currentTarget.open)}
          >
            <summary>Committee discussion</summary>
            <EvaluationDiscussionPanel />
          </details>
        </div>
      ) : null}
      {view === "assignments" ? (
        <div id="evaluation-assignments" className="pc-eval-view">
          <EvaluationSubmissionQueue />
          <AcceptedSpeakerInvitationsPanel />
          <EvaluationSessionQueue />
        </div>
      ) : null}
      {view === "setup" ? (
        <div id="evaluation-setup" className="pc-eval-view">
          <EvaluationRoundsPanel />
          <EvaluationProgressionPanel />
          <EvaluationTeamsPanel />
          <ReviewerAiSettingCard />
          <EvaluationReviewCyclePanel />
          <EvaluationModerationPanel />
        </div>
      ) : null}
    </>
  );
}
