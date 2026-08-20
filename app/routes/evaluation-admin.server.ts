import type { LoaderFunctionArgs } from "react-router";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { canReleaseEvaluationDecisions } from "./evaluation-admin-outcomes";
import { buildEvaluationAdminResultsModel } from "./evaluation-admin-results.server";

export { parseHistoricalReviewRevision } from "./evaluation-admin-results.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  await ensureDemoEvaluationData(env);
  const canPrepareReviewerReminders =
    viewer.role === "owner" || viewer.role === "administrator";
  const evaluationService = new EvaluationService(env);
  const [workspace, event, reviewerReminderTemplateRows, reviewerAiSetting] =
    await Promise.all([
      evaluationService.getAdminWorkspace(viewer),
      new EventService(env).getSetup(viewer),
      canPrepareReviewerReminders
        ? env.DB.prepare(
            `SELECT version.id, version.name, version.version_number AS versionNumber,
                  version.subject_template AS subject
             FROM communication_template_versions version
             JOIN communication_templates template
               ON template.id = version.template_id
              AND template.event_id = version.event_id
             JOIN events event
               ON event.id = version.event_id AND event.organisation_id = ?
            WHERE version.event_id = ? AND version.category = 'ad_hoc'
              AND version.channel = 'email' AND version.status = 'published'
              AND template.status = 'active'
            ORDER BY template.updated_at DESC, version.version_number DESC`,
          )
            .bind(viewer.organisationId, viewer.eventId)
            .all<{
              id: string;
              name: string;
              versionNumber: number;
              subject: string;
            }>()
        : Promise.resolve({ results: [] }),
      new ReviewerAiSuggestionService(env).setting(viewer),
    ]);
  const aiReviewAssessmentsSupported = event.repositoryProvider === "d1";
  const canManageAiAssessments =
    canPrepareReviewerReminders && aiReviewAssessmentsSupported;
  const aiAssessmentService = new AiReviewAssessmentService(env);
  const [aiReviewAssessments, aiReviewAssessmentGenerationAttempts] =
    await Promise.all([
      aiReviewAssessmentsSupported
        ? aiAssessmentService.listForEvent(viewer)
        : Promise.resolve([]),
      canManageAiAssessments
        ? aiAssessmentService.listGenerationAttempts(viewer)
        : Promise.resolve([]),
    ]);
  const resultsModel = await buildEvaluationAdminResultsModel({
    env,
    viewer,
    workspace,
    evaluationService,
    aiReviewAssessments,
    search: new URL(request.url).searchParams,
  });
  return {
    ...workspace,
    demoMode: viewer.demo,
    canReleaseDecisions: canReleaseEvaluationDecisions(
      viewer.role,
      workspace.plan,
    ),
    canAssessAiAdvisories:
      aiReviewAssessmentsSupported &&
      canReleaseEvaluationDecisions(viewer.role, workspace.plan),
    canManageEvaluationAccess:
      viewer.role === "owner" || viewer.role === "administrator",
    canPrepareReviewerReminders,
    canManageAiAssessments,
    reviewerAiSetting,
    aiReviewAssessmentsSupported,
    reviewerReminderTemplates: reviewerReminderTemplateRows.results,
    aiReviewAssessments,
    aiReviewAssessmentGenerationAttempts,
    ...resultsModel,
    eventTimezone: event.timezone,
    sessionFormats: event.sessionFormats,
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

export { action } from "./evaluation-admin-action.server";
