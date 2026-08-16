import { Form } from "react-router";

import { useEvaluationAdminModel } from "~/components/evaluation-admin-model";
import { AdminPageSection } from "~/components/ui/admin-page-sections";
import {
  AcceptedSpeakerInvitationsPanel,
  EvaluationModerationPanel,
  EvaluationProgressionPanel,
  EvaluationSessionQueue,
  EvaluationSubmissionQueue,
  EvaluationUnifiedResults,
} from "~/components/evaluation-admin-queue-panels";

import { EvaluationMetrics } from "~/components/evaluation-metrics";
import { EvaluationDiscussionPanel } from "~/components/evaluation-discussion-panel";
import { EvaluationReviewCyclePanel } from "~/components/evaluation-review-cycle-panel";
import { EvaluationRoundsPanel } from "~/components/evaluation-rounds-panel";
import { RubricFields } from "~/components/evaluation-rubric-fields";
import { EvaluationTeamsPanel } from "~/components/evaluation-teams-panel";
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
    <section className="card pad">
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
          <span>
            <strong>Allow reviewer-requested AI suggestions</strong>
            Sends reviewer-visible fields from the immutable source snapshot
            and the current scorecard to the organisation’s configured AI
            provider.
          </span>
        </label>
        <button className="btn" disabled={navigation.state !== "idle"}>
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
                className="input"
                type="datetime-local"
                name="roundOpensAt"
              />
            </label>
            <label className="label">
              Closes ({loaderData.eventTimezone})
              <input
                className="input"
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
            className="btn primary"
            disabled={navigation.state !== "idle"}
          >
            Create review plan
          </button>
        </Form>
      </section>
    </AdminPageSection>
  ) : (
    <>
      <AdminPageSection
        id="evaluation-overview"
        label="Evaluation overview"
        description="Progress metrics and review-cycle controls"
        defaultExpandedOnMobile
      >
        <EvaluationMetrics />
        <ReviewerAiSettingCard />
        <EvaluationReviewCyclePanel />
      </AdminPageSection>
      <AdminPageSection
        id="evaluation-access"
        label="Evaluation access"
        description="Teams, reviewers and invitations"
      >
        <EvaluationTeamsPanel />
      </AdminPageSection>
      <AdminPageSection
        id="evaluation-rounds"
        label="Rounds and progression"
        description="Rubrics, advancement and round state"
      >
        <EvaluationRoundsPanel />
        <EvaluationProgressionPanel />
      </AdminPageSection>
      <AdminPageSection
        id="evaluation-results"
        label="Review results"
        description="One score-ranked view across proposals and sessions"
      >
        <EvaluationUnifiedResults />
      </AdminPageSection>
      <EvaluationDiscussionPanel />
      <AdminPageSection
        id="evaluation-proposals"
        label="Proposal queue"
        description="Assignments, decisions and accepted-speaker invitations"
      >
        <EvaluationSubmissionQueue />
        <AcceptedSpeakerInvitationsPanel />
      </AdminPageSection>
      <AdminPageSection
        id="evaluation-sessions"
        label="Session queue"
        description="Accepted-session review targets"
      >
        <EvaluationSessionQueue />
      </AdminPageSection>
      <AdminPageSection
        id="evaluation-moderation"
        label="Moderation"
        description="Review disagreements, overrides and reopen history"
      >
        <EvaluationModerationPanel />
      </AdminPageSection>
    </>
  );
}
