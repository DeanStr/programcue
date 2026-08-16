import {
  index,
  layout,
  type RouteConfig,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.ts"),
  route("evaluate", "routes/evaluation-guide.tsx"),
  route("events/select", "routes/event-selector.tsx"),
  route("demo", "routes/demo-guide.tsx"),
  route("demo/role", "routes/demo-role.ts"),
  route("demo/reset/submissions", "routes/demo-reset-submissions.ts"),
  route(
    "demo/fixtures/communication-unsubscribe",
    "routes/demo-communication-unsubscribe-fixture.ts",
  ),
  route(
    "demo/fixtures/assistant-proposal",
    "routes/demo-assistant-proposal-fixture.ts",
  ),
  route("demo/fixtures/golden-path", "routes/demo-golden-path-fixture.ts"),
  route("api/v1/health", "routes/api-health.ts"),
  route(
    "api/internal/evaluation-fixture/reset",
    "routes/api-internal-evaluation-fixture-reset.ts",
  ),
  route("api/v1/events/:eventId", "routes/api-event.ts"),
  route(
    "api/v1/events/:eventId/evaluation/:resource",
    "routes/api-evaluation-resources.ts",
  ),
  route(
    "api/v1/events/:eventId/evaluation/me/:command",
    "routes/api-evaluation-person-command.ts",
  ),
  route(
    "api/v1/events/:eventId/evaluation/rounds/advance",
    "routes/api-evaluation-advance.ts",
  ),
  route(
    "api/v1/events/:eventId/integrations/:resource",
    "routes/api-integration-resources.ts",
  ),
  route(
    "api/v1/events/:eventId/integrations/accelevents/exports",
    "routes/api-accelevents-exports.ts",
  ),
  route(
    "api/v1/events/:eventId/participant/:resource",
    "routes/api-participant-resources.ts",
  ),
  route(
    "api/v1/events/:eventId/participant/submissions/:submissionId/:command",
    "routes/api-participant-submission-command.ts",
  ),
  route(
    "api/v1/events/:eventId/participant/tasks/:taskId/complete",
    "routes/api-participant-task-completion.ts",
  ),
  route(
    "api/v1/events/:eventId/sessions/direct",
    "routes/api-direct-sessions.ts",
  ),
  route(
    "api/v1/events/:eventId/communications/:command",
    "routes/api-communication-command.ts",
  ),
  route(
    "api/v1/events/:eventId/operations/:operationId/:command",
    "routes/api-operation-command.ts",
  ),
  route(
    "api/v1/events/:eventId/administration/:family/:itemId/:command",
    "routes/api-administration-command.ts",
  ),
  route("api/v1/events/:eventId/tasks/:taskId", "routes/api-task-item.ts"),
  route(
    "api/v1/events/:eventId/:resource/:itemId",
    "routes/api-administration-item.ts",
  ),
  route(
    "api/v1/events/:eventId/:resource",
    "routes/api-administration-resources.ts",
  ),
  route("api/v1/public/events/:slug", "routes/api-public-event.ts"),
  route("api/v1/public/events/:slug/sessions", "routes/api-public-sessions.ts"),
  route("api/v1/public/events/:slug/speakers", "routes/api-public-speakers.ts"),
  route("api/v1/public/events/:slug/schedule", "routes/api-public-schedule.ts"),
  route("api/v1/events/:eventId/operations", "routes/api-operations.ts"),
  route("api/v1/events/:eventId/tasks", "routes/api-tasks.ts"),
  route(
    "api/v1/events/:eventId/schedule/publish",
    "routes/api-schedule-publish.ts",
  ),
  route(
    "api/v1/public/events/:slug/programme",
    "routes/api-public-programme.ts",
  ),
  route(
    "api/v1/public/events/:slug/calendar.ics",
    "routes/api-public-calendar.ts",
  ),
  route("api/webhooks/resend", "routes/api-resend-webhook.ts"),
  route("api/webhooks/file-scanner", "routes/api-file-scanner-webhook.ts"),
  route("files/multipart/:operation", "routes/file-multipart.ts"),
  route("files/resource-attachment", "routes/resource-attachment.ts"),
  route("files/task-evidence", "routes/task-evidence-attachment.ts"),
  route(
    "apply/:slug/files/multipart/:operation",
    "routes/applicant-file-multipart.ts",
  ),
  route(
    "apply/:slug/import/sessionize",
    "routes/applicant-sessionize-import.ts",
  ),
  route("api/docs", "routes/api-docs.tsx"),
  route("api/auth/*", "routes/auth-api.ts"),
  route("oauth/calendar/:provider", "routes/calendar-oauth-start.ts"),
  route("oauth/calendar/callback", "routes/calendar-oauth-callback.ts"),
  route(
    "communications/unsubscribe/:token",
    "routes/communication-unsubscribe.tsx",
  ),
  route("admin/events/:eventId/changes", "routes/event-changes.ts"),
  route("ai/context", "routes/ai-context-action.ts"),
  route("admin/exports/:resource.csv", "routes/admin-data-export.ts"),
  layout("routes/admin-layout.tsx", [
    route("admin/command", "routes/command-centre.tsx"),
    route("admin/crm", "routes/admin-crm.tsx"),
    route("admin/crm/pipeline", "routes/admin-crm-pipeline.tsx"),
    route("admin/crm/outreach", "routes/admin-crm-outreach.tsx"),
    route("admin/crm/contacts/:personId", "routes/admin-crm-contact.tsx"),
    route("admin/assistant", "routes/assistant.tsx"),
    route("admin/events/new", "routes/admin-event-new.tsx"),
    route("admin/events/clone", "routes/admin-event-clone.tsx"),
    route(
      "admin/events/slug-availability",
      "routes/admin-event-slug-availability.ts",
    ),
    route(
      "admin/events/:eventId/repository-recovery",
      "routes/admin-event-repository-recovery.tsx",
    ),
    route("admin/search", "routes/admin-command-search.ts"),
    route("admin/views", "routes/admin-saved-views.ts"),
    route("admin/event", "routes/event-setup.tsx"),
    route("admin/branding", "routes/admin-branding.tsx"),
    route("admin/branding/assets/:assetId", "routes/admin-branding-asset.ts"),
    route("admin/operations", "routes/operation-centre.tsx"),
    route(
      "admin/communications/compose/:draftId?",
      "routes/communication-composer.tsx",
    ),
    route("admin/communications", "routes/communications-centre.tsx"),
    route("admin/review", "routes/evaluation-admin.tsx"),
    route("admin/review/results.csv", "routes/evaluation-results-export.ts"),
    route("admin/speakers", "routes/admin-speakers.tsx"),
    route("admin/people/search", "routes/admin-person-search.ts"),
    route(
      "admin/speakers/:personId/files/:assetId",
      "routes/admin-speaker-file-download.ts",
    ),
    route("admin/speakers/:personId", "routes/admin-speaker-detail.tsx"),
    route(
      "admin/tasks/files/:assetId/:versionId",
      "routes/admin-task-file-download.ts",
    ),
    route("admin/tasks", "routes/admin-tasks.tsx"),
    route("admin/tasks/bulk", "routes/admin-task-bulk.tsx"),
    route("admin/content", "routes/admin-content.tsx"),
    route("admin/content/export.zip", "routes/admin-content-zip.ts"),
    route(
      "admin/content/sessions/:sessionId",
      "routes/admin-content-session.tsx",
    ),
    route(
      "admin/content/files/:assetId/versions",
      "routes/admin-content-file-versions.ts",
    ),
    route(
      "admin/content/files/:assetId/versions/:versionId",
      "routes/admin-content-file-version-download.ts",
    ),
    route(
      "admin/content/files/:assetId",
      "routes/admin-content-file-download.ts",
    ),
    route("admin/files/retention", "routes/admin-file-retention.tsx"),
    route("admin/resources", "routes/admin-resources.tsx"),
    route("admin/settings", "routes/api-settings.tsx"),
    route("admin/integrations", "routes/integrations-admin.tsx"),
    route(
      "admin/integrations/accelevents/runs/:runId/reconciliation.csv",
      "routes/accelevents-reconciliation-report.ts",
    ),
    route("admin/submissions/form", "routes/form-builder-preview.tsx"),
    route("admin/schedule", "routes/schedule-planner.tsx"),
    route("admin/sessions/bulk", "routes/admin-session-bulk.tsx"),
    route("admin/submissions", "routes/submissions-admin.tsx", {
      id: "submissions-admin",
    }),
    route("admin/submissions/:submissionId", "routes/submissions-admin.tsx", {
      id: "submission-detail",
    }),
    route("admin/:section", "routes/admin-section.tsx"),
  ]),
  route("review/workbench", "routes/review-workbench.tsx"),
  route("review/discussion-page", "routes/evaluation-discussion-page.ts"),
  route("review/files/:assetId", "routes/review-file-download.ts"),
  layout("routes/speaker-layout.tsx", [
    route("participant/dashboard", "routes/speaker-dashboard.tsx"),
    route("participant/applications", "routes/participant-applications.tsx"),
    route("participant/sessions", "routes/speaker-sessions.tsx"),
    route("participant/tasks", "routes/speaker-tasks.tsx"),
    route("participant/files", "routes/speaker-files.tsx"),
    route("participant/profile", "routes/speaker-profile.tsx"),
    route("participant/resources", "routes/speaker-resources.tsx"),
  ]),
  route(
    "participant/tasks/files/:assetId/:versionId",
    "routes/speaker-task-file-download.ts",
  ),
  route("participant/files/:assetId", "routes/speaker-file-download.ts"),
  route(
    "participant/resources/files/:assetId",
    "routes/speaker-resource-download.ts",
  ),
  route("public/programme/:slug", "routes/public-programme.tsx", {
    id: "public-programme-by-slug",
  }),
  route("public/programme/:slug/:surface", "routes/public-programme.tsx", {
    id: "public-programme-surface",
  }),
  route(
    "public/programme/:slug/speakers/:personId/headshot",
    "routes/public-headshot.ts",
  ),
  route("public/brand/:slug/:kind", "routes/public-branding-asset.ts"),
  route("embed/:slug", "routes/public-programme.tsx", {
    id: "embed-programme",
  }),
  route("embed/:slug/saved/:embedSlug", "routes/public-programme.tsx", {
    id: "managed-embed-programme",
  }),
  route("embed/:slug/:surface", "routes/public-programme.tsx", {
    id: "embed-programme-surface",
  }),
  route("apply/:slug", "routes/application-form.tsx"),
  route("design/system", "routes/design-system.tsx"),
] satisfies RouteConfig;
