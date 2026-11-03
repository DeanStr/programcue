import type { LoaderFunctionArgs } from "react-router";
import {
  AiProviderSettingsService,
  aiProviderConfirmation,
} from "~/modules/ai/ai-provider-settings.server";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";
import { templateContentSchema } from "~/modules/communications/communication-schema";
import { decisionEventMergeValues } from "~/modules/communications/decision-notification-intent.server";
import { loadActiveDecisionTemplate } from "~/modules/communications/decision-notification-readiness.server";
import { mergeTemplateVariables } from "~/modules/communications/merge-template";
import { isStarterWording } from "~/modules/communications/starter-templates";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { buildEvaluationAdminResultsModel } from "~/modules/evaluations/evaluation-admin-results-model.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { canReleaseEvaluationDecisions } from "./evaluation-admin-outcomes";

export { parseHistoricalReviewRevision } from "~/modules/evaluations/evaluation-admin-results-model.server";

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
  const [
    workspace,
    event,
    reviewerReminderTemplateRows,
    reviewerAiSetting,
    decisionTemplate,
    decisionEvent,
  ] = await Promise.all([
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
    loadActiveDecisionTemplate(env, viewer),
    env.DB.prepare(
      `SELECT name, starts_at AS startsAt, ends_at AS endsAt
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ name: string; startsAt: number; endsAt: number }>(),
  ]);
  const aiReviewAssessmentsSupported = event.repositoryProvider === "d1";
  const canManageAiAssessments =
    canPrepareReviewerReminders && aiReviewAssessmentsSupported;
  const aiAssessmentService = new AiReviewAssessmentService(env);
  const [
    aiReviewAssessments,
    aiReviewAssessmentGenerationAttempts,
    aiReadiness,
  ] = await Promise.all([
    aiReviewAssessmentsSupported
      ? aiAssessmentService.listForEvent(viewer)
      : Promise.resolve([]),
    canManageAiAssessments
      ? aiAssessmentService.listGenerationAttempts(viewer)
      : Promise.resolve([]),
    canManageAiAssessments
      ? new AiProviderSettingsService(env).readiness(viewer)
      : Promise.resolve(null),
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
    aiAssessmentProvider: aiReadiness
      ? await aiProviderConfirmation(env, aiReadiness)
      : null,
    aiAssessmentProviderProblem: aiReadiness?.problem ?? null,
    ...resultsModel,
    eventTimezone: event.timezone,
    sessionFormats: event.sessionFormats,
    decisionEmail: decisionEmailSummary(decisionTemplate, decisionEvent),
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

/** What the release dialog shows about the decision email it will send.
 *  The version id goes back with release, which refuses a newer version. */
function decisionEmailSummary(
  template: Awaited<ReturnType<typeof loadActiveDecisionTemplate>>,
  event: { name: string; startsAt: number; endsAt: number } | null,
) {
  if (!template || !event) return null;
  const subjectTemplate = template.subjectTemplate ?? "";
  let body = "";
  try {
    const parsed = templateContentSchema.safeParse(
      JSON.parse(template.contentJson),
    );
    if (parsed.success) body = parsed.data.body;
  } catch {
    // Release reports the invalid stored template; the summary stays partial.
  }
  const variables = mergeTemplateVariables(`${subjectTemplate}\n${body}`);
  return {
    versionId: template.id,
    name: template.name,
    versionNumber: template.versionNumber,
    subjectTemplate,
    eventMergeValues: decisionEventMergeValues(event),
    includesRationale: variables.includes("decision.rationale"),
    includesFeedback: variables.includes("decision.feedback"),
    starterWording: isStarterWording({
      category: "decision",
      subject: subjectTemplate,
      body,
    }),
  };
}

export { action } from "./evaluation-admin-action.server";
