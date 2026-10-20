import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { listAssistantRunReports } from "~/modules/ai/ai-run-report.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export const READINESS_ACCEPTANCE_PROMPT =
  "What is the most important thing we need to resolve before this event is ready?";
export const READINESS_FIXTURE_MODEL = "fixture-readiness-model";
export type ReadinessFixtureScenario =
  | "success"
  | "insufficient_information"
  | "no_blockers"
  | "delivery_failures"
  | "provider_failure"
  | "stale_before_approval";

/** Explicit local/test fixture. Never used as a runtime provider fallback. */
export async function seedReadinessAcceptanceEvent(
  env: CloudflareEnvironment,
  organiser: Viewer,
  scenario: ReadinessFixtureScenario,
): Promise<{ viewer: Viewer; eventId: string; conflictId: string | null }> {
  const eventId = `assistant-acceptance-${crypto.randomUUID()}`;
  const versionId = crypto.randomUUID();
  const conflictId = crypto.randomUUID();
  const draftId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const sessionIds = [crypto.randomUUID(), crypto.randomUUID()];
  const entryIds = [crypto.randomUUID(), crypto.randomUUID()];
  const hasConflict = !["no_blockers", "delivery_failures"].includes(scenario);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (id, organisation_id, name, slug, timezone, starts_at, ends_at, description, file_policy_json) SELECT ?, organisation_id, 'Assistant acceptance event', ?, timezone, starts_at, ends_at, 'Isolated assistant workflow acceptance fixture', file_policy_json FROM events WHERE id = ? AND organisation_id = ?`,
    ).bind(eventId, eventId, organiser.eventId, organiser.organisationId),
    env.DB.prepare(
      `INSERT INTO memberships (id, organisation_id, event_id, person_id, role, accepted_at, created_at) VALUES (?, ?, ?, ?, 'administrator', unixepoch(), unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      organiser.organisationId,
      eventId,
      organiser.personId,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_versions (id, event_id, version_number, status, published_at) VALUES (?, ?, 1, 'published', unixepoch())`,
    ).bind(versionId, eventId),
    ...(!hasConflict
      ? []
      : [
          env.DB.prepare(
            `INSERT INTO rooms (id, event_id, name, capacity) VALUES (?, ?, 'Main Room', 100)`,
          ).bind(roomId, eventId),
          ...sessionIds.map((id, index) =>
            env.DB.prepare(
              `INSERT INTO sessions (id, event_id, title, slug, format, duration_minutes, status) VALUES (?, ?, ?, ?, 'presentation', 45, 'scheduled')`,
            ).bind(
              id,
              eventId,
              index === 0
                ? "Opening programme briefing"
                : "Venue operations briefing",
              `briefing-${index}`,
            ),
          ),
          env.DB.prepare(
            `INSERT INTO schedule_versions (id, event_id, version_number, status) VALUES (?, ?, 2, 'draft')`,
          ).bind(draftId, eventId),
          ...entryIds.map((id, index) =>
            env.DB.prepare(
              `INSERT INTO schedule_entries (id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at) SELECT ?, id, ?, ?, ?, starts_at + ?, starts_at + ? FROM events WHERE id = ?`,
            ).bind(
              id,
              draftId,
              sessionIds[index],
              roomId,
              index * 900,
              index * 900 + 2700,
              eventId,
            ),
          ),
          env.DB.prepare(
            `INSERT INTO schedule_conflicts (id, event_id, schedule_version_id, conflict_type, severity, fingerprint, details_json, primary_entry_id, conflicting_entry_id) VALUES (?, ?, ?, 'room', 'blocking', ?, ?, ?, ?)`,
          ).bind(
            conflictId,
            eventId,
            draftId,
            conflictId,
            JSON.stringify(
              scenario === "insufficient_information"
                ? {}
                : {
                    message:
                      "Opening programme briefing and Venue operations briefing overlap in Main Room. Coordinate a room or time change before publishing.",
                  },
            ),
            entryIds[0],
            entryIds[1],
          ),
        ]),
  ]);
  if (scenario === "delivery_failures") {
    for (const selected of [true, false]) {
      const communicationId = crypto.randomUUID();
      const deliveryId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO communications (id, event_id, idempotency_key, status, audience_json, content_snapshot_json, recipient_count, created_by_person_id) VALUES (?, ?, ?, ?, '{}', '{}', 1, ?)`,
        ).bind(
          communicationId,
          eventId,
          communicationId,
          selected ? "failed" : "sent",
          organiser.personId,
        ),
        env.DB.prepare(
          `INSERT INTO communication_deliveries (id, event_id, communication_id, recipient_address, recipient_name, channel, idempotency_key, status, failure_code) VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?)`,
        ).bind(
          deliveryId,
          eventId,
          communicationId,
          selected ? "venue@example.com" : "other@example.com",
          selected ? "Venue contact" : "Other communication recipient",
          deliveryId,
          selected ? "failed" : "delivered",
          selected ? "explicit_fixture_failure" : null,
        ),
      ]);
    }
  }
  return {
    viewer: { ...organiser, eventId },
    eventId,
    conflictId: hasConflict ? conflictId : null,
  };
}

export async function runDemonstrationReadinessScenario(
  env: CloudflareEnvironment,
  organiser: Viewer,
  scenario: ReadinessFixtureScenario,
  prompt = READINESS_ACCEPTANCE_PROMPT,
  existingFixture?: Awaited<ReturnType<typeof seedReadinessAcceptanceEvent>>,
) {
  const fixture =
    existingFixture ??
    (await seedReadinessAcceptanceEvent(env, organiser, scenario));
  let attempt = 0;
  const fetcher: typeof fetch = async (_request, init) => {
    attempt += 1;
    if (scenario === "provider_failure" && attempt === 2)
      return Response.json(
        {
          error: { message: "Explicitly injected acceptance provider failure" },
        },
        { status: 503 },
      );
    const request = JSON.parse(String(init?.body));
    const observation = request.input
      .filter((item: { type?: string }) => item.type === "function_call_output")
      .map((item: { output: string }) => JSON.parse(item.output))
      .find(
        (item: { recommendedAction?: unknown }) => "recommendedAction" in item,
      );
    const context = observation?.recommendedAction;
    const hasUncoveredRecords = context?.records.some(
      (record: { covered: boolean }) => !record.covered,
    );
    const shouldPropose =
      attempt === 2 && context?.sufficient && hasUncoveredRecords;
    const owner = context?.eligibleOwners.find(
      (candidate: { personId: string }) =>
        candidate.personId === fixture.viewer.personId,
    );
    if (shouldPropose && !owner)
      throw new Error(
        "The explicit readiness fixture requires the requesting organiser to be an eligible owner.",
      );
    const call =
      attempt === 1
        ? { name: "get_event_readiness", arguments: {} }
        : shouldPropose
          ? {
              name: "propose_task",
              arguments: {
                readinessBlockerKey: context.blockerKey,
                title:
                  scenario === "delivery_failures"
                    ? "Coordinate recovery of the failed communication delivery"
                    : "Coordinate resolution of the blocking schedule conflict",
                description:
                  scenario === "delivery_failures"
                    ? "Inspect the recorded failed delivery and coordinate a suitable recovery with the named organiser. Creating this task does not retry the delivery."
                    : "Ask the event organiser to coordinate the recorded schedule conflicts, verify suitable rooms or times, and recheck publication conflicts. Creating this task does not resolve the conflicts.",
                targetType: "event",
                targetId: fixture.eventId,
                ownerPersonId: owner.personId,
                taskType: "administrator_only",
                impact: "high",
                dueAt: null,
                dependencyIds: [],
              },
            }
          : null;
    return Response.json({
      id: crypto.randomUUID(),
      model: READINESS_FIXTURE_MODEL,
      status: "completed",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      output: call
        ? [
            {
              type: "function_call",
              call_id: crypto.randomUUID(),
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text:
                    context?.existingWork?.length && !hasUncoveredRecords
                      ? "The recorded room conflict still prevents publication. Follow the existing coordination task in the inspected sources; no duplicate task was proposed."
                      : context?.sufficient
                        ? scenario === "delivery_failures"
                          ? "A communication delivery failed. Inspect its source card for the selected communication's recipient deliveries. I saved one coordination task preview for review; the delivery has not been retried."
                          : "The recorded schedule conflicts prevent publication. I saved one coordination task preview for the named event organiser. Review the supporting conflict records and approve or edit the preview; the blockers remain unresolved."
                        : context
                          ? "A blocking room conflict is recorded, but the supporting record lacks enough detail to propose suitable work. Inspect the conflict before proposing a task."
                          : "No readiness blockers were detected in the current records. Event setup is incomplete; this does not establish overall event readiness. No task was proposed.",
                },
              ],
            },
          ],
    });
  };
  const service = new AiAssistantService(env, {
    fetcher,
    providerConfiguration: {
      apiKey: "explicit-demonstration-key-not-a-provider-credential",
      model: READINESS_FIXTURE_MODEL,
    },
  });
  let result: Awaited<ReturnType<typeof service.ask>> | null = null;
  let error: string | null = null;
  try {
    result = await service.ask(fixture.viewer, prompt);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (scenario === "stale_before_approval" && !fixture.conflictId)
    throw new Error("The stale-approval fixture requires a recorded conflict.");
  if (scenario === "stale_before_approval")
    await env.DB.prepare(
      `UPDATE schedule_conflicts SET resolved_at = unixepoch() WHERE id = ? AND event_id = ?`,
    )
      .bind(fixture.conflictId, fixture.eventId)
      .run();
  return {
    demonstrationOnly: true,
    providerCalled: false,
    scenario,
    ...fixture,
    result,
    error,
    reports: await listAssistantRunReports(env, fixture.viewer),
  };
}
