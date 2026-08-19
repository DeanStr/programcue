import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { assistantProposalMetadataSchema } from "~/modules/ai/ai-tools.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { ProgrammeEmbedService } from "~/modules/programme/programme-embed-service.server";
import { getValidatedPublishedPublicSite } from "~/modules/public-site/validated-public-site.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import { readSpeakerProfileHistory } from "~/modules/speakers/speaker-profile-revision.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_ASSISTANT_FIXTURE_MODEL,
  DEMO_VENUE_ADDRESS,
  DEMO_VENUE_MAP_URL,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import { ensureDemoPublicSite } from "~/platform/demo/demo-public-site-seed.server";
import {
  DEMO_SHOWCASE_ENABLED_PAGES,
  DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID,
  DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
  DEMO_SHOWCASE_SITE_SPONSORS,
  DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID,
  demoShowcasePublishedSponsors,
} from "~/platform/demo/demo-reset-fixtures";
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
import { ensureDemoData } from "./seed.server";

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
  describe("cleanup inventory", () => {
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
  });

  describe("baseline reconstruction", () => {
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
        assignments: 3,
        publishedSchedules: 1,
        canonicalEventConfiguration: 1,
        canonicalOrganisationMemberships: 1,
        publishedTemplates: 5,
        showcaseCompletedReviews: 2,
        showcaseReviewScoreSpread: 1,
        showcaseDiscussionMessages: 1,
        showcasePublishedDecisions: 1,
        showcaseProfileRevisions: 1,
        showcaseManagedEmbeds: 1,
        showcasePublishedPublicSites: 1,
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
        accent: DEFAULT_EVENT_BRAND_ACCENT,
        provider: "d1",
        activationStatus: "active",
        participantLogoUrl: null,
        participantWelcomeText: null,
        participantSupportUrl: null,
        venueAddress: DEMO_VENUE_ADDRESS,
        venueMapUrl: DEMO_VENUE_MAP_URL,
        programmeHeroImageUrl: null,
        firstFormat: "keynote",
        headshotMaximumBytes: 10 * 1_048_576,
        retentionCompletedAt: null,
        startsAt: Date.parse("2027-05-20T00:00:00Z") / 1_000,
        endsAt: Date.parse("2027-05-22T23:59:59Z") / 1_000,
        timezone: "America/Toronto",
      });
      await expect(
        new ProgrammeEmbedService(testEnvironment).list(demoAdministrator),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Main website agenda",
            slug: "main-agenda",
            status: "active",
            revision: 2,
            createdByName: "Morgan Chen",
            updatedByName: "Morgan Chen",
            configuration: expect.objectContaining({
              surface: "schedule",
              density: "compact",
            }),
          }),
        ]),
      );
      await expect(
        new ProgrammeEmbedService(testEnvironment).getPublic(
          "future-of-events-2027",
          "main-agenda",
        ),
      ).resolves.toMatchObject({
        status: "active",
        configuration: expect.objectContaining({ surface: "schedule" }),
      });
      const publishedSite = await getValidatedPublishedPublicSite(
        testEnvironment,
        "future-of-events-2027",
        null,
      );
      expect(publishedSite?.revision).toBe(1);
      expect(publishedSite?.configuration).toMatchObject({
        tagline: "One destination for the whole event.",
        theme: "light",
        sectionVisibility: {
          introduction: true,
          featured_speakers: true,
          featured_sessions: true,
          statistics: true,
          venue: true,
          faq: false,
        },
        featuredSessionIds: ["demo-session-1", "demo-session-2"],
        featuredSpeakerIds: ["person-demo-speaker", "person-demo-submitter"],
        pages: {
          about: { enabled: true, navigationLabel: "About" },
          faq: { enabled: true, navigationLabel: "FAQ" },
          venue: { enabled: true, navigationLabel: "Venue" },
          "code-of-conduct": {
            enabled: true,
            navigationLabel: "Code of conduct",
          },
          sponsors: { enabled: true, navigationLabel: "Sponsors" },
        },
      });
      // The published order is the organiser's, headline tier first, and the
      // fictional showcase organisations carry no website or logo.
      expect(publishedSite?.configuration.sponsors).toEqual(
        demoShowcasePublishedSponsors(),
      );
      expect(
        publishedSite?.configuration.sponsors
          .slice(0, 2)
          .map((sponsor) => [sponsor.name, sponsor.tier]),
      ).toEqual([
        ["Northstar Events", "Headline partner"],
        ["EventLab", "Major partner"],
      ]);
      await expect(
        testEnvironment.DB.prepare(
          `SELECT draft_revision AS draftRevision,
                  published_revision AS publishedRevision,
                  json_extract(draft_json, '$.sponsors') AS draftSponsors
             FROM event_public_sites
            WHERE event_id = ?`,
        )
          .bind(DEMO_EVENT_ID)
          .first(),
      ).resolves.toEqual({
        draftRevision: 1,
        publishedRevision: 1,
        draftSponsors: null,
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT kind, record_id AS recordId, site_revision AS siteRevision
             FROM event_public_site_references
            WHERE event_id = ?
            ORDER BY kind, record_id`,
        )
          .bind(DEMO_EVENT_ID)
          .all(),
      ).resolves.toMatchObject({
        results: [
          { kind: "session", recordId: "demo-session-1", siteRevision: 1 },
          { kind: "session", recordId: "demo-session-2", siteRevision: 1 },
          {
            kind: "speaker",
            recordId: "person-demo-speaker",
            siteRevision: 1,
          },
          {
            kind: "speaker",
            recordId: "person-demo-submitter",
            siteRevision: 1,
          },
        ],
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT entity_type AS entityType, change_type AS changeType,
                  correlation_id AS correlationId
             FROM event_changes
            WHERE event_id = ? AND entity_type = 'public_site'
              AND change_type = 'published' AND correlation_id = ?`,
        )
          .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID)
          .first(),
      ).resolves.toEqual({
        entityType: "public_site",
        changeType: "published",
        correlationId: DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
      });
      await expect(
        readSpeakerProfileHistory(testEnvironment, {
          organisationId: DEMO_ORGANISATION_ID,
          eventId: DEMO_EVENT_ID,
          personId: "person-demo-speaker",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "demo-showcase-profile-revision-1",
          profileRevision: 1,
          displayName: "Priya Shah",
          publicationStatus: "published",
          recordedByName: "Morgan Chen",
        }),
      ]);
      const evaluation = new EvaluationService(testEnvironment);
      const evaluationWorkspace =
        await evaluation.getAdminWorkspace(demoAdministrator);
      expect(
        evaluationWorkspace.assignments
          .filter(
            (assignment) =>
              assignment.submissionId === "demo-evaluation-submission-calm" &&
              assignment.reviewStatus === "submitted",
          )
          .map((assignment) => ({
            status: assignment.status,
            revision: assignment.revision,
            score: assignment.weightedScore,
            recommendation: assignment.recommendation,
          })),
      ).toEqual([
        {
          status: "submitted",
          revision: 2,
          score: 4.55,
          recommendation: "accept",
        },
        {
          status: "submitted",
          revision: 2,
          score: 2.25,
          recommendation: "reject",
        },
      ]);
      const submissionService = new SubmissionService(testEnvironment);
      for (const submissionId of [
        "demo-evaluation-submission-calm",
        "demo-evaluation-submission-inclusive",
      ]) {
        await expect(
          submissionService.getAdminSubmission(demoAdministrator, submissionId),
        ).resolves.toMatchObject({
          id: submissionId,
          routingExplanation: {
            source: {
              kind: "published_form",
              formName: "Evaluation demo proposals",
              versionNumber: 1,
            },
          },
        });
      }
      await expect(
        evaluation.listDiscussion(demoAdministrator, {
          roundId: "demo-evaluation-round",
          targetType: "submission",
          targetId: "demo-evaluation-submission-calm",
        }),
      ).resolves.toMatchObject({
        writable: true,
        messages: [
          expect.objectContaining({
            id: "demo-showcase-discussion-1",
            authorPersonId: "person-demo-chair",
          }),
        ],
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT decision.decided_by_person_id AS decidedByPersonId,
                submission.status AS submissionStatus,
                submission.revision AS submissionRevision,
                operation.status AS notificationOperationStatus,
                communication.status AS communicationStatus,
                delivery.status AS deliveryStatus,
                delivery.failure_code AS deliveryFailureCode
           FROM submission_decisions decision
           JOIN submissions submission
             ON submission.id = decision.submission_id
            AND submission.event_id = decision.event_id
           JOIN operation_jobs operation
             ON operation.id = decision.notification_operation_id
            AND operation.event_id = decision.event_id
           JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = decision.event_id
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
            AND delivery.event_id = decision.event_id
          WHERE decision.id = 'demo-showcase-decision-waitlist'`,
        ).first(),
      ).resolves.toEqual({
        decidedByPersonId: "person-demo-owner",
        submissionStatus: "waitlisted",
        submissionRevision: 3,
        notificationOperationStatus: "cancelled",
        communicationStatus: "cancelled",
        deliveryStatus: "cancelled",
        deliveryFailureCode: "DEMO_FIXTURE_NOT_DISPATCHED",
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE id LIKE 'audit-demo-showcase-%'
            AND event_id = ?`,
        )
          .bind(DEMO_EVENT_ID)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 8 });
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

    it("does not restore deleted public-site rows after the organiser edits the fixture generation", async () => {
      const testEnvironment = demoEnvironment();
      await ensureJudgedDemoWorkflow(testEnvironment);

      try {
        await testEnvironment.DB.batch([
          testEnvironment.DB.prepare(
            `UPDATE event_public_sites
                SET draft_revision = 2, last_operation_id = 'demo-edited-public-site',
                    updated_at = unixepoch()
              WHERE event_id = ? AND last_operation_id = ?`,
          ).bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID),
          testEnvironment.DB.prepare(
            "DELETE FROM event_site_sponsors WHERE event_id = ? AND id = ?",
          ).bind(DEMO_EVENT_ID, DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID),
          testEnvironment.DB.prepare(
            `DELETE FROM event_public_site_references
              WHERE event_id = ? AND kind = 'session' AND record_id = 'demo-session-2'`,
          ).bind(DEMO_EVENT_ID),
          testEnvironment.DB.prepare(
            `DELETE FROM event_changes
              WHERE event_id = ? AND entity_type = 'public_site'
                AND change_type = 'published' AND correlation_id = ?`,
          ).bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID),
        ]);

        const prepared = await prepareJudgedDemoWorkflow(testEnvironment);
        expect(prepared.complete).toBe(false);
        expect(prepared.evidence.showcasePublishedPublicSites).toBe(0);

        await expect(
          testEnvironment.DB.prepare(
            `SELECT last_operation_id AS lastOperationId, draft_revision AS draftRevision
               FROM event_public_sites
              WHERE event_id = ?`,
          )
            .bind(DEMO_EVENT_ID)
            .first(),
        ).resolves.toEqual({
          lastOperationId: "demo-edited-public-site",
          draftRevision: 2,
        });
        await expect(
          testEnvironment.DB.prepare(
            "SELECT id FROM event_site_sponsors WHERE event_id = ? AND id = ?",
          )
            .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID)
            .first(),
        ).resolves.toBeNull();
        await expect(
          testEnvironment.DB.prepare(
            `SELECT record_id AS recordId FROM event_public_site_references
              WHERE event_id = ? AND kind = 'session' AND record_id = 'demo-session-2'`,
          )
            .bind(DEMO_EVENT_ID)
            .first(),
        ).resolves.toBeNull();
        await expect(
          testEnvironment.DB.prepare(
            `SELECT correlation_id AS correlationId FROM event_changes
              WHERE event_id = ? AND entity_type = 'public_site'
                AND change_type = 'published' AND correlation_id = ?`,
          )
            .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID)
            .first(),
        ).resolves.toBeNull();
      } finally {
        await testEnvironment.DB.prepare(
          `UPDATE event_public_sites
              SET draft_revision = 1, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE event_id = ?`,
        )
          .bind(DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID, DEMO_EVENT_ID)
          .run();
        await ensureDemoPublicSite(testEnvironment);
      }
    });

    it("restores missing public-site rows only while the seeded generation is still active", async () => {
      const testEnvironment = demoEnvironment();
      await ensureJudgedDemoWorkflow(testEnvironment);
      await testEnvironment.DB.batch([
        testEnvironment.DB.prepare(
          "DELETE FROM event_site_sponsors WHERE event_id = ? AND id = ?",
        ).bind(DEMO_EVENT_ID, DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID),
        testEnvironment.DB.prepare(
          `DELETE FROM event_changes
            WHERE event_id = ? AND entity_type = 'public_site'
              AND change_type = 'published' AND correlation_id = ?`,
        ).bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID),
      ]);

      await ensureDemoPublicSite(testEnvironment);

      await expect(
        testEnvironment.DB.prepare(
          "SELECT id FROM event_site_sponsors WHERE event_id = ? AND id = ?",
        )
          .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID)
          .first(),
      ).resolves.toEqual({ id: DEMO_SHOWCASE_SPONSOR_EVENTLAB_ID });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT correlation_id AS correlationId FROM event_changes
            WHERE event_id = ? AND entity_type = 'public_site'
              AND change_type = 'published' AND correlation_id = ?`,
        )
          .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID)
          .first(),
      ).resolves.toEqual({
        correlationId: DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
      });
    });

    it("reports a stale homepage FAQ setting as an incomplete baseline", async () => {
      const testEnvironment = demoEnvironment();
      await ensureJudgedDemoWorkflow(testEnvironment);

      try {
        await testEnvironment.DB.prepare(
          `UPDATE event_public_sites
              SET draft_json = json_set(
                    draft_json, '$.sectionVisibility.faq', json('true')
                  ),
                  published_json = json_set(
                    published_json, '$.sectionVisibility.faq', json('true')
                  )
            WHERE event_id = ? AND last_operation_id = ?`,
        )
          .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID)
          .run();

        const prepared = await prepareJudgedDemoWorkflow(testEnvironment);
        expect(prepared.complete).toBe(false);
        expect(prepared.evidence.showcasePublishedPublicSites).toBe(0);
      } finally {
        await testEnvironment.DB.prepare(
          `UPDATE event_public_sites
              SET draft_json = json_set(
                    draft_json, '$.sectionVisibility.faq', json('false')
                  ),
                  published_json = json_set(
                    published_json, '$.sectionVisibility.faq', json('false')
                  )
            WHERE event_id = ? AND last_operation_id = ?`,
        )
          .bind(DEMO_EVENT_ID, DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID)
          .run();
      }
    });

    /* A database seeded by an earlier fixture generation must not be topped up
       into a mixture of the two. The seed inserts on OR IGNORE, so the site row
       and the publication audit both survive; only the generation identity
       tells the seed that what is already there is not what it would write. */
    it("refuses to top up a database left on a previous fixture generation", async () => {
      const testEnvironment = demoEnvironment();
      await ensureJudgedDemoWorkflow(testEnvironment);
      const previousGeneration = "demo-showcase:public-site-publish-2";
      const previousAuditId = "audit-demo-showcase-public-site-published-2";
      const previousAuditMetadata = JSON.stringify({
        revision: 1,
        sections: [
          "introduction",
          "featured_speakers",
          "featured_sessions",
          "statistics",
          "venue",
          "faq",
        ],
        pages: DEMO_SHOWCASE_ENABLED_PAGES,
        sponsorCount: DEMO_SHOWCASE_SITE_SPONSORS.length,
      });
      expect(DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID).not.toBe(previousAuditId);
      await testEnvironment.DB.batch([
        testEnvironment.DB.prepare(
          `UPDATE event_public_sites SET last_operation_id = ?
            WHERE event_id = ? AND last_operation_id = ?`,
        ).bind(
          previousGeneration,
          DEMO_EVENT_ID,
          DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        ),
        testEnvironment.DB.prepare(
          "DELETE FROM event_site_sponsors WHERE event_id = ?",
        ).bind(DEMO_EVENT_ID),
        /* Audit rows cannot be rewritten or deleted. Model the record the old
           fixture left behind so this test requires the two generations to use
           distinct ids and proves reset preserves both. */
        testEnvironment.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id,
             event_id, actor_person_id, action, entity_type, entity_id,
             correlation_id, metadata_json, created_at
           ) VALUES (?, 'person', 'internal', 1, ?, ?, 'person-demo-admin',
                     'public_site.published', 'public_site', ?, ?, ?, 1)`,
        ).bind(
          previousAuditId,
          DEMO_ORGANISATION_ID,
          DEMO_EVENT_ID,
          DEMO_EVENT_ID,
          previousGeneration,
          previousAuditMetadata,
        ),
      ]);

      const stale = await prepareJudgedDemoWorkflow(testEnvironment);
      expect(stale.complete).toBe(false);
      // No sponsors are written beside the previous generation's own records.
      await expect(
        testEnvironment.DB.prepare(
          "SELECT COUNT(*) AS count FROM event_site_sponsors WHERE event_id = ?",
        )
          .bind(DEMO_EVENT_ID)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
      // The site the organiser is holding is left exactly as it was found.
      await expect(
        testEnvironment.DB.prepare(
          `SELECT last_operation_id AS lastOperationId FROM event_public_sites
            WHERE event_id = ?`,
        )
          .bind(DEMO_EVENT_ID)
          .first(),
      ).resolves.toEqual({ lastOperationId: previousGeneration });

      await resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      );

      await expect(
        testEnvironment.DB.prepare(
          "SELECT COUNT(*) AS count FROM event_site_sponsors WHERE event_id = ?",
        )
          .bind(DEMO_EVENT_ID)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: DEMO_SHOWCASE_SITE_SPONSORS.length });
      /* Audit history is append-only and outlives the reset, so the current
         generation must write its own row rather than inherit a record whose
         page list and sponsor count describe the fixture it replaced. */
      await expect(
        testEnvironment.DB.prepare(
          `SELECT correlation_id AS correlationId, metadata_json AS metadataJson
             FROM audit_events WHERE id = ? AND event_id = ?`,
        )
          .bind(DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID, DEMO_EVENT_ID)
          .first<{ correlationId: string; metadataJson: string }>(),
      ).resolves.toEqual({
        correlationId: DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        metadataJson: JSON.stringify({
          revision: 1,
          sections: [
            "introduction",
            "featured_speakers",
            "featured_sessions",
            "statistics",
            "venue",
          ],
          pages: DEMO_SHOWCASE_ENABLED_PAGES,
          sponsorCount: DEMO_SHOWCASE_SITE_SPONSORS.length,
        }),
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT correlation_id AS correlationId, metadata_json AS metadataJson
             FROM audit_events WHERE id = ? AND event_id = ?`,
        )
          .bind(previousAuditId, DEMO_EVENT_ID)
          .first<{ correlationId: string; metadataJson: string }>(),
      ).resolves.toEqual({
        correlationId: previousGeneration,
        metadataJson: previousAuditMetadata,
      });
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

        await expect(
          prepareJudgedDemoWorkflow(testEnvironment),
        ).resolves.toEqual(
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

        await expect(
          prepareJudgedDemoWorkflow(testEnvironment),
        ).resolves.toEqual(
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
        throw new Error(
          "The required demo communication templates are absent.",
        );
      }

      const expectIncomplete = async () => {
        await expect(
          prepareJudgedDemoWorkflow(testEnvironment),
        ).resolves.toEqual(
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
  });

  describe("relational cleanup ordering", () => {
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
            taskProposalMetadata(
              fixtureProposalId,
              DEMO_ASSISTANT_FIXTURE_MODEL,
            ),
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
        baseline: { submissions: 2, assignments: 3 },
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
  });

  describe("destructive-operation guards", () => {
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
      await expect(
        testEnvironment.FILES.head(objectKey),
      ).resolves.not.toBeNull();
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
      await expect(
        testEnvironment.FILES.head(objectKey),
      ).resolves.not.toBeNull();
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
});
