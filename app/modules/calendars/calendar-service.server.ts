import type { Viewer } from "~/platform/auth/authorize.server";
import type { CalendarProviderName } from "./calendar-schema";
import { CalendarLifecycleService } from "./calendar-lifecycle-service.server";
import { PublishedScheduleCalendarService } from "./published-schedule-calendar-service.server";

export {
  CalendarQueueUnavailableError,
  CalendarStateError,
} from "./calendar-errors";
export {
  publishedScheduleCalendarIdempotencyKey,
  scheduleCalendarFanoutSnapshotStatements,
  SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE,
} from "./calendar-fanout";
export type {
  CalendarQueueActor,
  PublishedScheduleCalendarDispatch,
} from "./calendar-fanout";

export class CalendarService {
  private readonly lifecycle: CalendarLifecycleService;
  private readonly publishedSchedule: PublishedScheduleCalendarService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.lifecycle = new CalendarLifecycleService(env);
    this.publishedSchedule = new PublishedScheduleCalendarService(env);
  }

  async list(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `
      SELECT ci.id, ci.session_id AS sessionId, s.title AS sessionTitle,
             ci.person_id AS personId, p.display_name AS personName, p.email,
             ci.ical_uid AS icalUid, ci.sequence_number AS sequenceNumber,
             ci.method, ci.status, ci.provider_event_id AS providerEventId,
             ci.updated_at AS updatedAt,
             (SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS provider
        FROM calendar_invitations ci
        JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
        JOIN sessions s ON s.id = ci.session_id AND s.event_id = ci.event_id
        JOIN people p ON p.id = ci.person_id
       WHERE ci.event_id = ?
       ORDER BY ci.updated_at DESC
       LIMIT 50
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        sessionId: string;
        sessionTitle: string;
        personId: string;
        personName: string;
        email: string;
        icalUid: string;
        sequenceNumber: number;
        method: string;
        status: string;
        providerEventId: string | null;
        updatedAt: number;
        provider: CalendarProviderName | null;
      }>();
    return result.results;
  }

  queueLifecycle(
    ...args: Parameters<CalendarLifecycleService["queueLifecycle"]>
  ) {
    return this.lifecycle.queueLifecycle(...args);
  }

  queuePublishedSchedule(
    ...args: Parameters<
      PublishedScheduleCalendarService["queuePublishedSchedule"]
    >
  ) {
    return this.publishedSchedule.queuePublishedSchedule(...args);
  }
}
