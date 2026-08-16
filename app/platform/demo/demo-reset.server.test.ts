import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { assistantProposalMetadataSchema } from "~/modules/ai/ai-tools.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_ASSISTANT_FIXTURE_MODEL,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import { ensureDemoData } from "./seed.server";
import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
  DEMO_RESET_EVENT_TABLES,
  DemoResetBusyError,
  DemoResetRetentionError,
  DemoResetUnavailableError,
  ensureJudgedDemoWorkflow,
  prepareJudgedDemoWorkflow,
  resetDemoEvent,
} from "./demo-reset.server";

function demoEnvironment(overrides: Partial<CloudflareEnvironment> = {}) {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "demo",
    DEMO_MODE: "true",
    DEFAULT_EVENT_ID: DEMO_EVENT_ID,
    ...overrides,
  } as CloudflareEnvironment;
}

const demoAdministrator: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  demo: true,
};

function taskProposalMetadata(proposalId: string, model: string) {
  return assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_task",
    runId: crypto.randomUUID(),
    model,
    arguments: {
      title: "Confirm venue accessibility handoff",
      description: "Confirm the documented handoff with the venue team.",
      targetType: "event",
      targetId: DEMO_EVENT_ID,
      ownerPersonId: null,
      taskType: "administrator_only",
      impact: "high",
      dueAt: null,
      dependencyIds: [],
    },
    preview: {
      id: proposalId,
      toolName: "propose_task",
      title: "Confirm venue accessibility handoff",
      summary: "Create one administrator task for the demo event.",
      consequence: "Approval creates one durable event task.",
      changes: [
        {
          field: "Task",
          before: null,
          after: "Confirm venue accessibility handoff",
        },
      ],
      approvalRequired: true,
    },
  });
}

describe("complete evaluator demo reset", () => {
  it("keeps the cleanup inventory aligned with every event-owned table except append-only audit", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const eventTables: string[] = [];
    for (const { name } of tables.results) {
      if (!/^[a-z][a-z0-9_]*$/u.test(name)) continue;
      const columns = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{
        name: string;
      }>();
      if (columns.results.some((column) => column.name === "event_id")) {
        eventTables.push(name);
      }
    }
    expect(eventTables.sort()).toEqual(
      [...DEMO_RESET_EVENT_TABLES, "audit_events"].sort(),
    );
  });

  it("deletes multi-track routing rows before their referenced parents", () => {
    const position = (table: (typeof DEMO_RESET_EVENT_TABLES)[number]) =>
      DEMO_RESET_EVENT_TABLES.indexOf(table);

    expect(position("submission_track_selections")).toBeLessThan(
      position("tracks"),
    );
    expect(position("submission_track_selections")).toBeLessThan(
      position("submissions"),
    );
    expect(position("submission_routing_teams")).toBeLessThan(
      position("evaluation_teams"),
    );
    expect(position("submission_routing_teams")).toBeLessThan(
      position("submissions"),
    );
  });

  it("clears only the demo R2 prefix, preserves audit history and restores the judged D1 baseline", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `UPDATE events
            SET name = 'Evaluator changed this', brand_accent = '#123456',
                activation_status = 'discarded',
                participant_logo_url = 'https://example.com/stale-logo.png',
                participant_welcome_text = 'Stale participant welcome',
                participant_support_url = 'https://example.com/stale-support',
                venue_address = 'Stale address',
                venue_map_url = 'https://example.com/stale-map',
                programme_hero_image_url = 'https://example.com/stale-hero.jpg',
                session_formats_json = '[{"key":"stale","label":"Stale","defaultDurationMinutes":15,"position":0}]',
                file_policy_json = '{"headshotMaximumBytes":1048576,"slidesMaximumBytes":1048576,"supportingDocumentMaximumBytes":1048576,"videoMaximumBytes":1048576}'
          WHERE id = ?`,
      ).bind(DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES ('demo-reset-stale-org-admin', ?, NULL, ?, 'administrator',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(DEMO_ORGANISATION_ID, SBEK_FIXTURE_PEOPLE.organizer.personId),
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES ('demo-reset-preserved-audit', 'person', 'internal', 1, ?, ?, 'person-demo-admin',
                   'test.sentinel', 'event', ?, '{}', unixepoch())
         ON CONFLICT(id) DO NOTHING`,
      ).bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID, DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `INSERT INTO assistant_proposal_executions (
           proposal_id, organisation_id, event_id, actor_person_id, tool_name,
           status, result_json, created_at, updated_at, completed_at
         ) VALUES ('demo-reset-stale-assistant-execution', ?, ?,
                   'person-demo-admin', 'propose_task', 'completed', '{}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `UPDATE schedule_session_contents
            SET title = 'Demo reset stale session content',
                updated_at = unixepoch()
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = ? AND session_id = 'demo-session-1'`,
      ).bind(DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `UPDATE people
            SET email = 'stale-speaker@example.com',
                display_name = 'Stale Speaker', profile_status = 'published'
          WHERE id = ?`,
      ).bind(SBEK_FIXTURE_PEOPLE.speaker.personId),
      testEnvironment.DB.prepare(
        `UPDATE people
            SET email = 'stale-speaker2@example.com',
                display_name = 'Stale Speaker Two', profile_status = 'published'
          WHERE id = ?`,
      ).bind(SBEK_FIXTURE_PEOPLE.speaker2.personId),
      testEnvironment.DB.prepare(
        `INSERT INTO event_brand_assets (
           id, organisation_id, event_id, kind, object_key, object_etag,
           original_filename, content_type, size_bytes, width_px, height_px,
           normalizer_version, normalized_at, created_by_person_id
         ) VALUES (
           'demo-reset-brand', ?, ?, 'logo', ?, '"demo-reset-brand"',
           'brand.webp', 'image/webp', 5, 1, 1,
           'cloudflare-images-webp-v1', unixepoch(), 'person-demo-admin'
         )`,
      ).bind(
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        `${DEMO_R2_PREFIX}branding/logo/demo-reset-brand`,
      ),
      testEnvironment.DB.prepare(
        `UPDATE events SET brand_logo_asset_id = 'demo-reset-brand'
          WHERE id = ? AND organisation_id = ?`,
      ).bind(DEMO_EVENT_ID, DEMO_ORGANISATION_ID),
    ]);
    await testEnvironment.FILES.put(`${DEMO_R2_PREFIX}old/slides.pdf`, "old");
    await testEnvironment.FILES.put(
      `${DEMO_R2_PREFIX}branding/logo/demo-reset-brand`,
      "brand",
    );
    await testEnvironment.FILES.put(
      "private/events/another-event/keep.pdf",
      "keep",
    );

    const reset = await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );

    expect(reset.objectCount).toBe(2);
    expect(reset.baseline).toMatchObject({
      submissions: 2,
      assignments: 2,
      publishedSchedules: 1,
      canonicalEventConfiguration: 1,
      canonicalOrganisationMemberships: 1,
      publishedTemplates: 5,
      sbekPeople: 4,
      sbekReviewerMemberships: 0,
      sbekReviewerAssignments: 0,
      sbekSpeakerMemberships: 0,
      sbekSpeakerTasks: 0,
      sbekFixtureSubmissions: 0,
      sbekApplicantMemberships: 0,
    });
    await expect(
      testEnvironment.FILES.head(`${DEMO_R2_PREFIX}old/slides.pdf`),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        "SELECT id FROM event_brand_assets WHERE id = 'demo-reset-brand'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.FILES.head("private/events/another-event/keep.pdf"),
    ).resolves.not.toBeNull();
    const event = await testEnvironment.DB.prepare(
      `SELECT name, brand_accent AS accent, repository_provider AS provider,
              activation_status AS activationStatus,
              participant_logo_url AS participantLogoUrl,
              participant_welcome_text AS participantWelcomeText,
              participant_support_url AS participantSupportUrl,
              venue_address AS venueAddress,
              venue_map_url AS venueMapUrl,
              programme_hero_image_url AS programmeHeroImageUrl,
              json_extract(session_formats_json, '$[0].key') AS firstFormat,
              json_extract(file_policy_json, '$.headshotMaximumBytes') AS headshotMaximumBytes,
              participant_retention_completed_at AS retentionCompletedAt,
              starts_at AS startsAt, ends_at AS endsAt, timezone
         FROM events WHERE id = ?`,
    )
      .bind(DEMO_EVENT_ID)
      .first<{
        name: string;
        accent: string;
        provider: string;
        activationStatus: string;
        participantLogoUrl: string | null;
        participantWelcomeText: string | null;
        participantSupportUrl: string | null;
        venueAddress: string | null;
        venueMapUrl: string | null;
        programmeHeroImageUrl: string | null;
        firstFormat: string;
        headshotMaximumBytes: number;
        retentionCompletedAt: number | null;
        startsAt: number;
        endsAt: number;
        timezone: string;
      }>();
    expect(event).toEqual({
      name: "Future of Events 2027",
      accent: "#4f46e5",
      provider: "d1",
      activationStatus: "active",
      participantLogoUrl: null,
      participantWelcomeText: null,
      participantSupportUrl: null,
      venueAddress: null,
      venueMapUrl: null,
      programmeHeroImageUrl: null,
      firstFormat: "keynote",
      headshotMaximumBytes: 10 * 1_048_576,
      retentionCompletedAt: null,
      startsAt: Date.parse("2027-05-20T00:00:00Z") / 1_000,
      endsAt: Date.parse("2027-05-22T23:59:59Z") / 1_000,
      timezone: "America/Toronto",
    });
    const form = await testEnvironment.DB.prepare(
      `SELECT closes_at AS closesAt
         FROM form_definitions
        WHERE event_id = ? AND public_slug = 'form'`,
    )
      .bind(DEMO_EVENT_ID)
      .first<{ closesAt: number }>();
    expect(eventLocalCalendarDate(form!.closesAt, event!.timezone)).toBe(
      "2027-04-30",
    );
    await expect(
      testEnvironment.DB.prepare(
        `SELECT id, person_id AS personId, role
           FROM memberships
          WHERE organisation_id = ? AND event_id IS NULL`,
      )
        .bind(DEMO_ORGANISATION_ID)
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          id: "membership-demo-owner",
          personId: "person-demo-owner",
          role: "owner",
        },
      ],
    });
    const schedulePolicy = await testEnvironment.DB.prepare(
      `SELECT room_overlap_action AS roomAction,
              speaker_overlap_action AS speakerAction
         FROM schedule_policies
        WHERE event_id = ?`,
    )
      .bind(DEMO_EVENT_ID)
      .first<{ roomAction: string; speakerAction: string }>();
    expect(schedulePolicy).toEqual({
      roomAction: "block",
      speakerAction: "warn",
    });
    const datedSpeakerTasks = await testEnvironment.DB.prepare(
      `SELECT id, due_at AS dueAt
         FROM task_instances
        WHERE event_id = ? AND owner_person_id = 'person-demo-speaker'
          AND due_at IS NOT NULL
        ORDER BY id`,
    )
      .bind(DEMO_EVENT_ID)
      .all<{ id: string; dueAt: number }>();
    expect(datedSpeakerTasks.results).toEqual([
      {
        id: "task-demo-handbook",
        dueAt: Date.parse("2027-05-12T16:00:00Z") / 1_000,
      },
      {
        id: "task-demo-profile",
        dueAt: Date.parse("2027-05-10T16:00:00Z") / 1_000,
      },
      {
        id: "task-demo-slides",
        dueAt: Date.parse("2027-05-16T16:00:00Z") / 1_000,
      },
    ]);
    const communicationCentre = await new CommunicationService(
      testEnvironment,
    ).listCentre(demoAdministrator);
    expect(
      communicationCentre.templates
        .filter((template) => template.versionStatus === "published")
        .map((template) => template.name),
    ).toEqual([
      "Speaker welcome",
      "Speaker task reminder",
      "Reviewer reminder",
      "Proposal decision",
      "Submission confirmation",
    ]);
    expect(
      communicationCentre.templates.find(
        (template) => template.name === "Speaker welcome",
      ),
    ).toMatchObject({
      category: "ad_hoc",
      templateStatus: "active",
      versionStatus: "published",
      subject: "Welcome to {{event.name}} speakers",
      content: {
        body: "Hi {{recipient.firstName}},\n\nWelcome to {{event.name}}. Your speaker workspace is ready.",
      },
    });
    expect(
      communicationCentre.templates.find(
        (template) => template.name === "Speaker task reminder",
      ),
    ).toMatchObject({
      category: "task_reminder",
      templateStatus: "active",
      versionStatus: "published",
      subject: "Reminder: {{task.title}} is due {{task.dueDate}}",
      content: {
        body: "Hi {{recipient.firstName}},\n\nPlease complete {{task.title}} for {{event.name}} by {{task.dueDate}}.",
      },
    });
    const fixturePeople = await testEnvironment.DB.prepare(
      `SELECT id, email, display_name AS name, profile_status AS profileStatus
         FROM people
        WHERE id IN (?, ?, ?, ?)
        ORDER BY id`,
    )
      .bind(
        ...Object.values(SBEK_FIXTURE_PEOPLE).map(({ personId }) => personId),
      )
      .all<{
        id: string;
        email: string;
        name: string;
        profileStatus: string;
      }>();
    expect(fixturePeople.results).toEqual(
      Object.values(SBEK_FIXTURE_PEOPLE)
        .map(({ personId: id, email, name, profileStatus }) => ({
          id,
          email,
          name,
          profileStatus,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(
      testEnvironment.DB.prepare(
        "SELECT proposal_id FROM assistant_proposal_executions WHERE proposal_id = 'demo-reset-stale-assistant-execution'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `SELECT title FROM schedule_session_contents
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = ? AND session_id = 'demo-session-1'`,
      )
        .bind(DEMO_EVENT_ID)
        .first<{ title: string }>(),
    ).resolves.toEqual({ title: "The Future of Attendee Engagement" });
    const audits = await testEnvironment.DB.prepare(
      "SELECT action FROM audit_events WHERE id = 'demo-reset-preserved-audit' OR action = 'demo.reset' ORDER BY created_at",
    ).all<{ action: string }>();
    expect(audits.results.map((row) => row.action)).toEqual(
      expect.arrayContaining(["test.sentinel", "demo.reset"]),
    );
  });

  it("reports stale required communication templates as an incomplete baseline", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);

    try {
      await testEnvironment.DB.prepare(
        `UPDATE communication_templates
            SET status = 'archived'
          WHERE event_id = ? AND name = 'Reviewer reminder'`,
      )
        .bind(DEMO_EVENT_ID)
        .run();

      await expect(prepareJudgedDemoWorkflow(testEnvironment)).resolves.toEqual(
        expect.objectContaining({
          complete: false,
          evidence: expect.objectContaining({ publishedTemplates: 4 }),
        }),
      );
      await expect(ensureJudgedDemoWorkflow(testEnvironment)).rejects.toThrow(
        "The restored demo baseline is incomplete.",
      );

      await testEnvironment.DB.prepare(
        `UPDATE communication_templates
            SET status = 'active'
          WHERE event_id = ? AND name = 'Reviewer reminder'`,
      )
        .bind(DEMO_EVENT_ID)
        .run();
      await testEnvironment.DB.prepare(
        `UPDATE communication_template_versions
            SET status = 'retired'
          WHERE event_id = ? AND name = 'Reviewer reminder'`,
      )
        .bind(DEMO_EVENT_ID)
        .run();

      await expect(prepareJudgedDemoWorkflow(testEnvironment)).resolves.toEqual(
        expect.objectContaining({
          complete: false,
          evidence: expect.objectContaining({ publishedTemplates: 4 }),
        }),
      );
    } finally {
      await testEnvironment.DB.batch([
        testEnvironment.DB.prepare(
          `UPDATE communication_templates
              SET status = 'active'
            WHERE event_id = ? AND name = 'Reviewer reminder'`,
        ).bind(DEMO_EVENT_ID),
        testEnvironment.DB.prepare(
          `UPDATE communication_template_versions
              SET status = 'published'
            WHERE event_id = ? AND name = 'Reviewer reminder'`,
        ).bind(DEMO_EVENT_ID),
      ]);
    }
  });

  it("reports semantic drift in either required communication template as incomplete", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    const requiredTemplates = await testEnvironment.DB.prepare(
      `SELECT template.id AS templateId, version.id AS versionId,
              template.name AS templateName
         FROM communication_templates template
         JOIN communication_template_versions version
           ON version.template_id = template.id
          AND version.event_id = template.event_id
        WHERE template.event_id = ?
          AND template.name IN ('Speaker task reminder', 'Reviewer reminder')`,
    )
      .bind(DEMO_EVENT_ID)
      .all<{
        templateId: string;
        versionId: string;
        templateName: string;
      }>();
    const templatesByName = new Map(
      requiredTemplates.results.map((template) => [
        template.templateName,
        template,
      ]),
    );
    const speaker = templatesByName.get("Speaker task reminder");
    const reviewer = templatesByName.get("Reviewer reminder");
    if (!speaker || !reviewer) {
      throw new Error("The required demo communication templates are absent.");
    }

    const expectIncomplete = async () => {
      await expect(prepareJudgedDemoWorkflow(testEnvironment)).resolves.toEqual(
        expect.objectContaining({
          complete: false,
          evidence: expect.objectContaining({ publishedTemplates: 4 }),
        }),
      );
      await expect(ensureJudgedDemoWorkflow(testEnvironment)).rejects.toThrow(
        "The restored demo baseline is incomplete.",
      );
    };

    try {
      await testEnvironment.DB.prepare(
        `UPDATE communication_template_versions
            SET name = 'Drifted reviewer reminder',
                category = 'schedule', channel = 'sms'
          WHERE event_id = ? AND id = ?`,
      )
        .bind(DEMO_EVENT_ID, reviewer.versionId)
        .run();
      await expectIncomplete();

      await testEnvironment.DB.prepare(
        `UPDATE communication_template_versions
            SET name = 'Reviewer reminder',
                category = 'ad_hoc', channel = 'email'
          WHERE event_id = ? AND id = ?`,
      )
        .bind(DEMO_EVENT_ID, reviewer.versionId)
        .run();
      await testEnvironment.DB.batch([
        testEnvironment.DB.prepare(
          `UPDATE communication_templates
              SET name = 'Drifted speaker reminder', category = 'ad_hoc'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, speaker.templateId),
        testEnvironment.DB.prepare(
          `UPDATE communication_template_versions
              SET name = 'Drifted speaker reminder',
                  category = 'ad_hoc', channel = 'sms'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, speaker.versionId),
      ]);
      await expectIncomplete();
    } finally {
      await testEnvironment.DB.batch([
        testEnvironment.DB.prepare(
          `UPDATE communication_templates
              SET name = 'Speaker task reminder',
                  category = 'task_reminder', status = 'active'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, speaker.templateId),
        testEnvironment.DB.prepare(
          `UPDATE communication_template_versions
              SET name = 'Speaker task reminder',
                  category = 'task_reminder', channel = 'email',
                  status = 'published'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, speaker.versionId),
        testEnvironment.DB.prepare(
          `UPDATE communication_templates
              SET name = 'Reviewer reminder',
                  category = 'ad_hoc', status = 'active'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, reviewer.templateId),
        testEnvironment.DB.prepare(
          `UPDATE communication_template_versions
              SET name = 'Reviewer reminder', category = 'ad_hoc',
                  channel = 'email', status = 'published'
            WHERE event_id = ? AND id = ?`,
        ).bind(DEMO_EVENT_ID, reviewer.versionId),
      ]);
    }
  });

  it("tombstones only stale demo assistant fixture proposals while preserving their audits", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    const fixtureProposalId = crypto.randomUUID();
    const ordinaryProposalId = crypto.randomUUID();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'assistant.proposal.previewed',
                   'assistant_proposal', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        demoAdministrator.personId,
        fixtureProposalId,
        crypto.randomUUID(),
        JSON.stringify(
          taskProposalMetadata(fixtureProposalId, DEMO_ASSISTANT_FIXTURE_MODEL),
        ),
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'assistant.proposal.previewed',
                   'assistant_proposal', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        demoAdministrator.personId,
        ordinaryProposalId,
        crypto.randomUUID(),
        JSON.stringify(taskProposalMetadata(ordinaryProposalId, "gpt-5.6")),
      ),
    ]);

    const reset = await resetDemoEvent(
      testEnvironment,
      demoAdministrator.personId,
      DEMO_RESET_CONFIRMATION,
    );

    expect(reset.supersededAssistantFixtureProposals).toBe(1);
    await expect(
      resetDemoEvent(
        testEnvironment,
        demoAdministrator.personId,
        DEMO_RESET_CONFIRMATION,
      ),
    ).resolves.toMatchObject({ supersededAssistantFixtureProposals: 0 });
    const fixtureAudits = await testEnvironment.DB.prepare(
      `SELECT action, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND entity_type = 'assistant_proposal'
          AND entity_id = ?
        ORDER BY created_at, id`,
    )
      .bind(DEMO_EVENT_ID, fixtureProposalId)
      .all<{ action: string; metadataJson: string }>();
    expect(fixtureAudits.results).toHaveLength(2);
    expect(fixtureAudits.results.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "assistant.proposal.previewed",
        "assistant.proposal.superseded",
      ]),
    );
    const tombstone = fixtureAudits.results.find(
      ({ action }) => action === "assistant.proposal.superseded",
    );
    expect(JSON.parse(tombstone?.metadataJson ?? "{}")).toMatchObject({
      proposalId: fixtureProposalId,
      reason: "demo_fixture_reset",
      fixtureModel: DEMO_ASSISTANT_FIXTURE_MODEL,
    });
    await expect(
      testEnvironment.DB.prepare(
        `SELECT action FROM audit_events
          WHERE event_id = ? AND entity_type = 'assistant_proposal'
            AND entity_id = ? AND action = 'assistant.proposal.superseded'`,
      )
        .bind(DEMO_EVENT_ID, ordinaryProposalId)
        .first(),
    ).resolves.toBeNull();
    const recent = await new AiAssistantService(
      testEnvironment,
    ).listRecentProposals(demoAdministrator);
    expect(recent.map(({ id }) => id)).not.toContain(fixtureProposalId);
    expect(recent.map(({ id }) => id)).toContain(ordinaryProposalId);
  });

  it("deletes routed submissions before their evaluation teams", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `INSERT INTO evaluation_teams (
           id, event_id, name, description, status, created_at, updated_at
         ) VALUES (
           'demo-reset-routed-team', ?, 'Reset routing sentinel',
           'Exercises the restrictive submissions routing foreign key.',
           'active', unixepoch(), unixepoch()
         )`,
      ).bind(DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `INSERT INTO submission_routing_teams (
           submission_id, event_id, team_id
         ) VALUES ('demo-evaluation-submission-calm', ?, 'demo-reset-routed-team')`,
      ).bind(DEMO_EVENT_ID),
    ]);

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).resolves.toMatchObject({
      baseline: { submissions: 2, assignments: 2 },
    });
    await expect(
      testEnvironment.DB.prepare(
        "SELECT id FROM evaluation_teams WHERE id = 'demo-reset-routed-team'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `SELECT COUNT(*) AS count FROM submission_routing_teams
          WHERE submission_id = 'demo-evaluation-submission-calm'
            AND event_id = ?`,
      )
        .bind(DEMO_EVENT_ID)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("refuses non-terminal work before changing D1 or R2", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    const suffix = crypto.randomUUID();
    await testEnvironment.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'person-demo-admin', 'demo.test', ?, ?, 'running', '{}',
                 1, 0, 0, unixepoch(), unixepoch())`,
    )
      .bind(
        `demo-active-${suffix}`,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        `demo-active-${suffix}`,
        `demo-active-${suffix}`,
      )
      .run();
    await testEnvironment.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-demo-owner'",
    ).run();
    const objectKey = `${DEMO_R2_PREFIX}active/file.txt`;
    await testEnvironment.FILES.put(objectKey, "active");

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toMatchObject({
      name: DemoResetBusyError.name,
      activeWork: { operations: 1 },
    });
    await expect(testEnvironment.FILES.head(objectKey)).resolves.not.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        "SELECT id FROM memberships WHERE id = 'membership-demo-owner'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        "SELECT status FROM operation_jobs WHERE id = ?",
      )
        .bind(`demo-active-${suffix}`)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "running" });

    await testEnvironment.DB.prepare(
      "UPDATE operation_jobs SET status = 'failed' WHERE id = ?",
    )
      .bind(`demo-active-${suffix}`)
      .run();
    await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );
  });

  it("fails promptly when demo storage deletion makes no progress", async () => {
    let listCalls = 0;
    let deleteCalls = 0;
    const stuckFiles = {
      list: async ({ prefix }: { prefix: string }) => {
        expect(prefix).toBe(DEMO_R2_PREFIX);
        listCalls += 1;
        return { objects: [{ key: `${prefix}stuck-object` }] };
      },
      delete: async () => {
        deleteCalls += 1;
      },
    } as unknown as R2Bucket;

    await expect(
      resetDemoEvent(
        demoEnvironment({ FILES: stuckFiles }),
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toThrow(/did not make progress/iu);
    expect(listCalls).toBe(4);
    expect(deleteCalls).toBe(3);
  });

  it("cannot run under production runtime settings", async () => {
    await expect(
      resetDemoEvent(
        demoEnvironment({ APP_ENV: "production", DEMO_MODE: "false" }),
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toBeInstanceOf(DemoResetUnavailableError);
  });

  it("fails before D1 mutation when the required private-file binding is absent", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    await testEnvironment.DB.prepare(
      "UPDATE events SET name = 'Binding failure sentinel' WHERE id = ?",
    )
      .bind(DEMO_EVENT_ID)
      .run();
    await expect(
      resetDemoEvent(
        {
          ...testEnvironment,
          FILES: undefined,
        } as unknown as CloudflareEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toThrow("Required Cloudflare binding FILES is unavailable");
    await expect(
      testEnvironment.DB.prepare("SELECT name FROM events WHERE id = ?")
        .bind(DEMO_EVENT_ID)
        .first<{ name: string }>(),
    ).resolves.toEqual({ name: "Binding failure sentinel" });
    await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );
  });

  it("does not clear an irreversible participant-retention tombstone", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    const objectKey = `${DEMO_R2_PREFIX}retained/file.txt`;
    await testEnvironment.FILES.put(objectKey, "retained");
    await testEnvironment.DB.prepare(
      `UPDATE events SET participant_retention_completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(DEMO_EVENT_ID, DEMO_ORGANISATION_ID)
      .run();

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toBeInstanceOf(DemoResetRetentionError);
    await expect(testEnvironment.FILES.head(objectKey)).resolves.not.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `UPDATE events SET participant_retention_completed_at = NULL
          WHERE id = ?`,
      )
        .bind(DEMO_EVENT_ID)
        .run(),
    ).rejects.toThrow("retention completion is immutable");
  });
});
