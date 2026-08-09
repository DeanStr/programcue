import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import { resendWebhookEventSchema } from "./communication-schema";
import {
  resendDeliveryEventStates,
  resendDeliveryEventStatesJson,
} from "./communication-service-shared";

export class ResendReconciliationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async reconcileResendEvent(
    input: unknown,
    rawPayload: string,
    providerEventId: string,
  ) {
    const event = resendWebhookEventSchema.parse(input);
    const delivery = await this.env.DB.prepare(
      `
      SELECT d.id, d.event_id AS eventId, d.communication_id AS communicationId,
             d.person_id AS personId, lower(d.recipient_address) AS address,
             e.organisation_id AS organisationId
        FROM communication_deliveries d
        JOIN events e ON e.id = d.event_id
       WHERE d.provider = 'resend' AND d.provider_message_id = ?
    `,
    )
      .bind(event.data.email_id)
      .first<{
        id: string;
        eventId: string;
        communicationId: string;
        personId: string | null;
        address: string;
        organisationId: string;
      }>();
    if (!delivery) return { matched: false, duplicate: false };
    const occurredAt = event.created_at
      ? Math.floor(Date.parse(event.created_at) / 1_000)
      : Math.floor(Date.now() / 1_000);
    const inserted = await this.env.DB.prepare(
      `
      INSERT OR IGNORE INTO communication_delivery_events (
        id, delivery_id, provider_event_id, event_type, payload_json, occurred_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `,
    )
      .bind(
        crypto.randomUUID(),
        delivery.id,
        providerEventId,
        event.type,
        rawPayload,
        occurredAt,
      )
      .run();
    const duplicate = (inserted.meta.changes ?? 0) !== 1;
    if (
      event.type === "email.complained" ||
      event.type === "email.suppressed"
    ) {
      await this.env.DB.prepare(
        `
        INSERT INTO communication_unsubscribes (
          id, event_id, person_id, address, category, reason, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, '*', ?, unixepoch(), NULL)
        ON CONFLICT(event_id, address, category) DO UPDATE SET
          person_id = COALESCE(excluded.person_id, communication_unsubscribes.person_id),
          reason = excluded.reason, revoked_at = NULL
      `,
      )
        .bind(
          crypto.randomUUID(),
          delivery.eventId,
          delivery.personId,
          delivery.address,
          event.type,
        )
        .run();
    }
    if (Object.hasOwn(resendDeliveryEventStates, event.type)) {
      await this.env.DB.prepare(
        `
        WITH event_states AS (
          SELECT json_extract(value, '$.eventType') AS event_type,
                 json_extract(value, '$.status') AS status,
                 json_extract(value, '$.precedenceRank') AS precedence_rank,
                 json_extract(value, '$.statusRank') AS status_rank
            FROM json_each(?)
        ),
        derived AS (
          SELECT delivery_event.event_type, event_state.status,
                 event_state.precedence_rank, event_state.status_rank
            FROM communication_delivery_events delivery_event
            JOIN event_states event_state ON event_state.event_type = delivery_event.event_type
           WHERE delivery_event.delivery_id = ?
           ORDER BY event_state.precedence_rank DESC,
                    CASE WHEN event_state.precedence_rank = 2 THEN delivery_event.occurred_at END DESC,
                    CASE WHEN event_state.precedence_rank = 1 THEN event_state.status_rank END DESC,
                    CASE WHEN event_state.precedence_rank = 2 THEN event_state.status_rank END DESC,
                    delivery_event.occurred_at DESC,
                    delivery_event.event_type DESC,
                    COALESCE(delivery_event.provider_event_id, '') DESC,
                    delivery_event.id DESC
           LIMIT 1
        )
        UPDATE communication_deliveries
           SET status = (SELECT status FROM derived),
               failure_code = CASE
                 WHEN (SELECT precedence_rank FROM derived) = 2
                   THEN (SELECT event_type FROM derived)
                 ELSE failure_code
               END,
               updated_at = unixepoch()
         WHERE id = ? AND EXISTS (SELECT 1 FROM derived)
      `,
      )
        .bind(resendDeliveryEventStatesJson, delivery.id, delivery.id)
        .run();
      await this.refreshCommunicationStatus(delivery.communicationId);
    }
    if (!duplicate) {
      await new EventRealtimeService(this.env).recordChange(
        {
          organisationId: delivery.organisationId,
          eventId: delivery.eventId,
        },
        {
          entityType: "communication_delivery",
          entityId: delivery.id,
          changeType: "progress",
          correlationId: providerEventId,
        },
      );
    }
    return { matched: true, duplicate };
  }

  private async refreshCommunicationStatus(communicationId: string) {
    const counts = await this.env.DB.prepare(
      `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status IN ('bounced','suppressed','failed') THEN 1 ELSE 0 END) AS failed
        FROM communication_deliveries WHERE communication_id = ?
    `,
    )
      .bind(communicationId)
      .first<{ total: number; succeeded: number; failed: number }>();
    if (!counts?.total) return;
    const terminal = counts.succeeded + counts.failed;
    if (terminal < counts.total) return;
    const status =
      counts.failed === 0
        ? "sent"
        : counts.succeeded
          ? "partially_failed"
          : "failed";
    await this.env.DB.prepare(
      `
      UPDATE communications SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN unixepoch() ELSE sent_at END,
        updated_at = unixepoch() WHERE id = ?
    `,
    )
      .bind(status, status, communicationId)
      .run();
  }
}
