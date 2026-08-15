import { CommunicationService } from "~/modules/communications/communication-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { EvaluationStateError } from "./evaluation-errors";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

import { reviewerReminderSchema } from "./evaluation-plan-workflow-support.server";

export class EvaluationReviewerReminderWorkflow extends EvaluationServiceFoundation {
  async prepareReviewerReminder(viewer: Viewer, input: unknown) {
    return this.readAuthoritative(viewer, () =>
      this.prepareReviewerReminderD1(viewer, input),
    );
  }

  protected async prepareReviewerReminderD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = reviewerReminderSchema.parse(input);
    const template = await this.env.DB.prepare(
      `SELECT version.id
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND version.status = 'published' AND version.channel = 'email'
          AND version.category = 'ad_hoc'
          AND template.status = 'active' AND template.category = 'ad_hoc'`,
    )
      .bind(viewer.organisationId, parsed.templateVersionId, viewer.eventId)
      .first<{ id: string }>();
    if (!template) {
      throw new EvaluationStateError(
        "Choose a published ad hoc email template from this event.",
      );
    }

    const reviewerPlaceholders = parsed.reviewerPersonIds
      .map(() => "?")
      .join(", ");
    const reviewers = await this.env.DB.prepare(
      `SELECT person.id AS personId, person.email
         FROM evaluation_round_reviewers pool
         JOIN evaluation_rounds round
           ON round.id = pool.round_id AND round.event_id = pool.event_id
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         JOIN people person ON person.id = pool.person_id
         JOIN events event
           ON event.id = pool.event_id AND event.organisation_id = ?
        WHERE pool.event_id = ? AND pool.round_id = ?
          AND pool.person_id IN (${reviewerPlaceholders})
          AND plan.status = 'active' AND round.status = 'active'
          AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
          AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
          AND EXISTS (
            SELECT 1
              FROM memberships membership
             WHERE membership.event_id = pool.event_id
               AND membership.person_id = pool.person_id
               AND membership.role IN ('evaluator', 'committee_chair')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM evaluator_assignments assignment
              LEFT JOIN submissions submission
                ON submission.id = assignment.submission_id
               AND submission.event_id = assignment.event_id
              LEFT JOIN sessions session
                ON session.id = assignment.session_id
               AND session.event_id = assignment.event_id
             WHERE assignment.event_id = pool.event_id
               AND assignment.round_id = pool.round_id
               AND assignment.evaluator_person_id = pool.person_id
               AND assignment.status IN ('assigned', 'in_progress', 'reopened')
               AND (
                 (assignment.submission_id IS NOT NULL
                  AND ${reviewableSubmissionSql("submission", "review")})
                 OR
                 (assignment.session_id IS NOT NULL
                  AND session.status NOT IN ('cancelled','archived'))
               )
          )
        ORDER BY person.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        parsed.roundId,
        ...parsed.reviewerPersonIds,
      )
      .all<{ personId: string; email: string }>();
    if (reviewers.results.length !== parsed.reviewerPersonIds.length) {
      throw new EvaluationStateError(
        "Every selected reviewer must be an accepted member of this round's pool with unfinished work in the currently open round.",
      );
    }

    return new CommunicationService(this.env).createDraft(viewer, {
      templateVersionId: parsed.templateVersionId,
      audienceType: "manual",
      manualRecipients: reviewers.results
        .map((reviewer) => reviewer.email)
        .join("\n"),
      kind: "transactional",
      scheduledAt: null,
    });
  }
}
