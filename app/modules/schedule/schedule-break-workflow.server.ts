import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ScheduleConfigurationError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { scheduleBreakSchema } from "./schedule-schema";
import type {
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";

export class ScheduleBreakWorkflow {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  async createBreakD1(viewer: Viewer, input: unknown) {
    const parsed = scheduleBreakSchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (!workspace.sessionFormats.some((format) => format.key === "break")) {
      throw new ScheduleConfigurationError(
        "Configure the break session format in Event Setup before creating breaks.",
      );
    }
    const configuredResources = new Set(
      workspace.rooms.flatMap((room) => room.resources),
    );
    const unconfigured = parsed.requiredResources.find(
      (resource) => !configuredResources.has(resource),
    );
    if (unconfigured) {
      throw new ScheduleConfigurationError(
        `Required resource “${unconfigured}” is not configured in any active room.`,
      );
    }
    const resources = parsed.requiredResources;
    const sessionId = crypto.randomUUID();
    const slug = `break-${sessionId}`;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}:1`,
        correlationId: `${sessionId}:1`,
        data: { format: "break", revision: 1 },
      },
      auditEventId,
    );
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, description, format, duration_minutes,
          required_resources_json, status, visibility, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, 'break', ?, ?, 'unscheduled', 'public', 1,
               unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND revision = ?
         )
      `,
      ).bind(
        sessionId,
        viewer.eventId,
        parsed.title,
        slug,
        `${parsed.title} break`,
        parsed.durationMinutes,
        JSON.stringify(resources),
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.break.created', 'session', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        sessionId,
        JSON.stringify({
          title: parsed.title,
          durationMinutes: parsed.durationMinutes,
          requiredResources: resources,
        }),
        sessionId,
        viewer.eventId,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((inserted.meta.changes ?? 0) !== 1)
      throw new ScheduleRevisionConflictError();
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return { sessionId };
  }
}
