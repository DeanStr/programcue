import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-out", "routes/sign-out.ts"),
  route("demo/role", "routes/demo-role.ts"),
  route("demo/reset/submissions", "routes/demo-reset-submissions.ts"),
  route(
    "demo/fixtures/communication-unsubscribe",
    "routes/demo-communication-unsubscribe-fixture.ts",
  ),
  route("api/v1/health", "routes/api-health.ts"),
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
  route("api/docs", "routes/api-docs.tsx"),
  route("api/auth/*", "routes/auth-api.ts"),
  route(
    "communications/unsubscribe/:token",
    "routes/communication-unsubscribe.tsx",
  ),
  route("admin/events/:eventId/changes", "routes/event-changes.ts"),
  layout("routes/admin-layout.tsx", [
    route("admin/command", "routes/command-centre.tsx"),
    route("admin/event", "routes/event-setup.tsx"),
    route("admin/operations", "routes/operation-centre.tsx"),
    route("admin/communications", "routes/communications-centre.tsx"),
    route("admin/review", "routes/evaluation-admin.tsx"),
    route("admin/speakers", "routes/admin-speakers.tsx"),
    route(
      "admin/tasks/files/:assetId/:versionId",
      "routes/admin-task-file-download.ts",
    ),
    route("admin/tasks", "routes/admin-tasks.tsx"),
    route("admin/resources", "routes/admin-resources.tsx"),
    route("admin/settings", "routes/api-settings.tsx"),
    route("admin/submissions/form", "routes/form-builder-preview.tsx"),
    route("admin/schedule", "routes/schedule-planner.tsx"),
    route("admin/submissions", "routes/submissions-admin.tsx", {
      id: "submissions-admin",
    }),
    route("admin/submissions/:submissionId", "routes/submissions-admin.tsx", {
      id: "submission-detail",
    }),
    route("admin/:section", "routes/admin-section.tsx"),
  ]),
  route("review/workbench", "routes/review-workbench.tsx"),
  route("speaker/dashboard", "routes/speaker-dashboard.tsx"),
  route("speaker/resources", "routes/speaker-resources.tsx"),
  route("speaker/files/:assetId", "routes/speaker-file-download.ts"),
  route(
    "speaker/resources/files/:assetId",
    "routes/speaker-resource-download.ts",
  ),
  route("public/programme", "routes/public-programme.tsx", {
    id: "public-programme",
  }),
  route("public/programme/:slug", "routes/public-programme.tsx", {
    id: "public-programme-by-slug",
  }),
  route("embed/:slug", "routes/public-programme.tsx", {
    id: "embed-programme",
  }),
  route("apply/:slug", "routes/application-form.tsx"),
  route("design/system", "routes/design-system.tsx"),
] satisfies RouteConfig;
