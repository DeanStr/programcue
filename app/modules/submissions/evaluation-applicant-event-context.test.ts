import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { EventCreationService } from "~/modules/events/event-creation-service.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  activateEvaluationApplicantAccount,
  evaluationSessionCookie,
} from "~/platform/evaluation/evaluation-session.server";
import {
  action as selectEvent,
  loader as loadEventSelector,
} from "~/routes/event-selector";
import { SubmissionService } from "./submission-service.server";

const baseEnv = env as unknown as CloudflareEnvironment;

const organizer: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "organizer@programcue.dev",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: false,
  evaluation: true,
};

function productionEvaluationEnvironment() {
  return {
    ...baseEnv,
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    BETTER_AUTH_URL: "https://app.programcue.com",
    BETTER_AUTH_SECRET:
      "evaluation-applicant-better-auth-secret-with-thirty-two-characters",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
  } as CloudflareEnvironment;
}

function routeContext(environment: CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function recordCompletedFixtureReset(environment: CloudflareEnvironment) {
  const generation = crypto.randomUUID();
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
               'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
               unixepoch())`,
  )
    .bind(generation)
    .run();
  return generation;
}

async function publishApplicationForm(
  environment: CloudflareEnvironment,
  viewer: Viewer,
  publicSlug: string,
) {
  const trackId = `track-${crypto.randomUUID()}`;
  await environment.DB.prepare(
    `INSERT INTO tracks (id, event_id, name, slug, position)
     VALUES (?, ?, 'Platform & Infra', 'platform-infra', 0)`,
  )
    .bind(trackId, viewer.eventId)
    .run();
  const service = new SubmissionService(environment);
  const defaults = await service.getDefaultFormInput(viewer);
  const formId = await service.saveForm(viewer, {
    ...defaults,
    name: `Evaluation form ${publicSlug}`,
    publicSlug,
  });
  const workspace = await service.getAdminWorkspace(viewer, formId);
  if (!workspace) throw new Error("The evaluation test form was not saved.");
  await service.publishForm(
    viewer,
    formId,
    workspace.revision,
    workspace.draftVersion.revision,
  );
  return { service, form: await service.getPublicForm(publicSlug) };
}

async function insertForeignEvent(environment: CloudflareEnvironment) {
  const organisationId = `org-foreign-${crypto.randomUUID()}`;
  const eventId = `evt-foreign-${crypto.randomUUID()}`;
  const personId = `person-foreign-${crypto.randomUUID()}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO organisations (id, name, slug)
       VALUES (?, 'Foreign evaluation test', ?)`,
    ).bind(organisationId, `foreign-${crypto.randomUUID()}`),
    environment.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         file_policy_json
       ) SELECT ?, ?, 'Foreign event', ?, 'UTC', 1800000000, 1800086400,
                file_policy_json
           FROM events WHERE id = 'evt-foe-2025'`,
    ).bind(eventId, organisationId, `foreign-event-${crypto.randomUUID()}`),
    environment.DB.prepare(
      `INSERT INTO people (id, email, display_name, email_verified, profile_status)
       VALUES (?, ?, 'Foreign organiser', 1, 'published')`,
    ).bind(personId, `${personId}@outside.invalidmail.dev`),
    environment.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, created_at
       ) VALUES (?, ?, NULL, ?, 'administrator', unixepoch(), unixepoch(),
                 unixepoch())`,
    ).bind(`membership-${personId}`, organisationId, personId),
  ]);
  return { organisationId, eventId, personId };
}

beforeEach(async () => {
  await ensureDemoData(baseEnv);
  await baseEnv.DB.prepare(
    `INSERT OR REPLACE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES ('membership-evaluation-org-admin', 'org-future-events', NULL,
               'person-demo-admin', 'administrator', unixepoch(),
               unixepoch(), unixepoch())`,
  ).run();
});

describe("production evaluation applicant event context", () => {
  it("does not fall through from a gate-only evaluator session to Better Auth or an applicant token", async () => {
    const environment = productionEvaluationEnvironment();
    await recordCompletedFixtureReset(environment);
    const { service, form } = await publishApplicationForm(
      environment,
      organizer,
      `exclusive-auth-cfp-${crypto.randomUUID()}`,
    );
    const prepared = await service.applicants.prepareVerifiedSession(
      form,
      "person-demo-owner",
    );
    await environment.DB.batch([
      environment.DB.prepare(
        `UPDATE people SET email_verified = 1
          WHERE id = 'person-demo-owner'`,
      ),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(
        prepared.persistence.sessionId,
        prepared.persistence.identifier,
        prepared.persistence.sessionHash,
      ),
    ]);
    const authToken = `applicant-dual-session-${crypto.randomUUID()}`;
    await environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, person_id, token, expires_at, created_at, updated_at
       ) VALUES (?, 'person-demo-owner', ?, unixepoch() + 3600,
                 unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), authToken)
      .run();
    const betterAuthCookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      authToken,
      String(environment.BETTER_AUTH_SECRET),
    );
    const applicantCookie = prepared.cookie.split(";", 1)[0]!;
    const gateCookie = (await evaluationSessionCookie(environment, null)).split(
      ";",
      1,
    )[0]!;

    await expect(
      service.applicants.get(
        new Request("https://app.programcue.com/apply/exclusive", {
          headers: {
            cookie: `${gateCookie}; ${betterAuthCookie}; ${applicantCookie}`,
          },
        }),
        form,
      ),
    ).resolves.toBeNull();
    await expect(
      service.applicants.get(
        new Request("https://app.programcue.com/apply/exclusive", {
          headers: { cookie: betterAuthCookie },
        }),
        form,
      ),
    ).resolves.toMatchObject({ personId: "person-demo-owner" });
    await expect(
      service.applicants.get(
        new Request("https://app.programcue.com/apply/exclusive", {
          headers: { cookie: applicantCookie },
        }),
        form,
      ),
    ).resolves.toMatchObject({ personId: "person-demo-owner" });
  });

  it("uses explicit fixed-account activation on a same-organisation public form and grants only the draft's event membership", async () => {
    const environment = productionEvaluationEnvironment();
    const generation = await recordCompletedFixtureReset(environment);
    await activateEvaluationApplicantAccount(environment, generation);
    const evaluationCookie = (
      await evaluationSessionCookie(environment, "sbek_applicant")
    ).split(";", 1)[0]!;

    const event = await new EventCreationService(environment).create(
      organizer,
      {
        creationIntentId: crypto.randomUUID(),
        name: "DevFlow Conf 2027",
        slug: `devflow-conf-${crypto.randomUUID()}`,
        timezone: "America/Los_Angeles",
        startDate: "2027-05-12",
        endDate: "2027-05-14",
        repositoryProvider: "d1",
        personalAccessToken: "",
        baseId: "",
        tableName: "Program Cue Rooms",
      },
    );
    const devFlowViewer = { ...organizer, eventId: event.eventId };
    const { service, form } = await publishApplicationForm(
      environment,
      devFlowViewer,
      `devflow-cfp-${crypto.randomUUID()}`,
    );
    const request = new Request("https://app.programcue.com/apply/devflow", {
      headers: { cookie: evaluationCookie },
    });

    const applicant = await service.applicants.get(request, form);
    expect(applicant).toMatchObject({
      personId: "person-sbek-speaker",
      name: "Priya Raman",
      verified: true,
      evaluation: true,
    });
    await expect(
      environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM memberships
          WHERE event_id = ? AND person_id = 'person-sbek-speaker'`,
      )
        .bind(event.eventId)
        .first(),
    ).resolves.toEqual({ count: 0 });

    const draftId = await service.createDraft(
      form.publicSlug,
      applicant!,
      crypto.randomUUID(),
    );
    await expect(
      environment.DB.prepare(
        `SELECT membership.role, membership.accepted_at AS acceptedAt,
                membership.revoked_at AS revokedAt,
                submission.submitter_person_id AS submitterPersonId
           FROM memberships membership
           JOIN submissions submission
             ON submission.event_id = membership.event_id
            AND submission.id = ?
          WHERE membership.organisation_id = 'org-future-events'
            AND membership.event_id = ?
            AND membership.person_id = 'person-sbek-speaker'
            AND membership.role = 'submitter'`,
      )
        .bind(draftId, event.eventId)
        .first(),
    ).resolves.toMatchObject({
      role: "submitter",
      acceptedAt: expect.any(Number),
      revokedAt: null,
      submitterPersonId: "person-sbek-speaker",
    });
  });

  it("does not apply the fixed evaluator account to a public form in another organisation", async () => {
    const environment = productionEvaluationEnvironment();
    const generation = await recordCompletedFixtureReset(environment);
    await activateEvaluationApplicantAccount(environment, generation);
    const evaluationCookie = (
      await evaluationSessionCookie(environment, "sbek_applicant")
    ).split(";", 1)[0]!;
    const foreign = await insertForeignEvent(environment);
    const foreignViewer: Viewer = {
      ...organizer,
      personId: foreign.personId,
      name: "Foreign organiser",
      email: `${foreign.personId}@outside.invalidmail.dev`,
      organisationId: foreign.organisationId,
      eventId: foreign.eventId,
      evaluation: false,
    };
    const { service, form } = await publishApplicationForm(
      environment,
      foreignViewer,
      `foreign-cfp-${crypto.randomUUID()}`,
    );

    await expect(
      service.applicants.get(
        new Request("https://app.programcue.com/apply/foreign", {
          headers: { cookie: evaluationCookie },
        }),
        form,
      ),
    ).resolves.toBeNull();
    await expect(
      environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM memberships
          WHERE organisation_id = ? AND person_id = 'person-sbek-speaker'`,
      )
        .bind(foreign.organisationId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("lets Priya explicitly accept a same-organisation speaker invitation and use that event's portal and tasks", async () => {
    const queued: unknown[] = [];
    const environment = {
      ...productionEvaluationEnvironment(),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "evaluation-provider-test-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const generation = await recordCompletedFixtureReset(environment);
    await activateEvaluationApplicantAccount(environment, generation);
    await environment.DB.batch([
      environment.DB.prepare(
        "UPDATE people SET email = 'evaluation-organizer@programcue.dev' WHERE id = 'person-demo-admin'",
      ),
      environment.DB.prepare(
        "UPDATE people SET email = 'evaluation-priya@programcue.dev' WHERE id = 'person-sbek-speaker'",
      ),
      environment.DB.prepare(
        "UPDATE people SET email = 'evaluation-marcus@programcue.dev' WHERE id = 'person-sbek-speaker2'",
      ),
      environment.DB.prepare(
        "UPDATE people SET email = 'evaluation-reviewer@programcue.dev' WHERE id = 'person-sbek-reviewer'",
      ),
    ]);
    const evaluationCookie = (
      await evaluationSessionCookie(environment, "sbek_applicant")
    ).split(";", 1)[0]!;

    const event = await new EventCreationService(environment).create(
      organizer,
      {
        creationIntentId: crypto.randomUUID(),
        name: "DevFlow Conf 2027",
        slug: `devflow-speaker-${crypto.randomUUID()}`,
        timezone: "America/Los_Angeles",
        startDate: "2027-05-12",
        endDate: "2027-05-14",
        repositoryProvider: "d1",
        personalAccessToken: "",
        baseId: "",
        tableName: "Program Cue Rooms",
      },
    );
    const devFlowOrganizer = { ...organizer, eventId: event.eventId };
    await environment.DB.batch([
      environment.DB.prepare(
        `UPDATE events SET venue_name = 'Pier 27', city = 'San Francisco'
          WHERE id = ? AND organisation_id = ?`,
      ).bind(event.eventId, organizer.organisationId),
      environment.DB.prepare(
        `INSERT INTO sender_profiles (
           id, event_id, name, from_name, from_email, reply_to_email,
           provider, provider_sender_id, status, created_at, updated_at
         ) VALUES (?, ?, 'DevFlow evaluation sender', 'DevFlow Conf',
                   'events@programcue.dev', 'events@programcue.dev',
                   'resend', 'domain-programcue-dev', 'verified',
                   unixepoch(), unixepoch())`,
      ).bind(`sender-${crypto.randomUUID()}`, event.eventId),
    ]);

    const speakers = new SpeakerService(environment);
    const roster = await speakers.addManualSpeakerRecord(devFlowOrganizer, {
      idempotencyKey: `devflow-roster:${crypto.randomUUID()}`,
      name: "Priya Raman",
      email: "priya.speaker@sbek-test.example.com",
      jobTitle: "Principal Engineer",
      organisationName: "Signal Works",
      biography: "Builds reliable developer platforms.",
    });
    expect(roster).toMatchObject({
      personId: "person-sbek-speaker",
      email: "evaluation-priya@programcue.dev",
      createdIdentity: false,
    });
    const invitation = await speakers.inviteSpeakerRecord(devFlowOrganizer, {
      idempotencyKey: `devflow-invite:${crypto.randomUUID()}`,
      personId: roster.personId,
      confirmation: "send",
    });
    expect(invitation).toMatchObject({
      personId: "person-sbek-speaker",
      accepted: false,
      delivery: "queued",
    });
    expect(queued).toHaveLength(1);

    const tasks = new TaskService(environment);
    const templateId = await tasks.createTemplate(devFlowOrganizer, {
      name: "Confirm DevFlow participation",
      description: "Confirm the event participation details.",
      targetType: "speaker",
      taskType: "checklist",
      impact: "high",
      evidenceMode: "checkbox",
      dueAnchor: "none",
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: false,
      dependencyIds: [],
    });
    await tasks.assignTemplate(
      devFlowOrganizer,
      templateId,
      "person-sbek-speaker",
    );

    const selectorRequest = new Request(
      `https://app.programcue.com/events/select?eventId=${event.eventId}`,
      { headers: { cookie: evaluationCookie } },
    );
    const selection = await loadEventSelector({
      request: selectorRequest,
      params: {},
      context: routeContext(environment),
    } as never);
    expect(selection.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: event.eventId,
          eventName: "DevFlow Conf 2027",
          role: "speaker",
          invitationPending: true,
          pendingInvitationRole: "speaker",
        }),
      ]),
    );

    const selected = await selectEvent({
      request: new Request("https://app.programcue.com/events/select", {
        method: "POST",
        headers: {
          cookie: evaluationCookie,
          origin: "https://app.programcue.com",
        },
        body: new URLSearchParams({
          eventId: event.eventId,
          returnTo: "/",
        }),
      }),
      params: {},
      context: routeContext(environment),
    } as never);
    expect(selected.status).toBe(303);
    expect(selected.headers.get("location")).toBe("/participant/dashboard");
    const eventCookie = (selected.headers.get("set-cookie") ?? "").split(
      ";",
      1,
    )[0]!;
    const speakerViewer = await requireCurrentEventRole(
      new Request("https://app.programcue.com/participant/dashboard", {
        headers: { cookie: `${evaluationCookie}; ${eventCookie}` },
      }),
      environment,
      ["speaker"],
    );
    expect(speakerViewer).toMatchObject({
      personId: "person-sbek-speaker",
      organisationId: "org-future-events",
      eventId: event.eventId,
      role: "speaker",
      evaluation: true,
    });
    await expect(speakers.getPortal(speakerViewer)).resolves.toMatchObject({
      event: { name: "DevFlow Conf 2027" },
      profile: { name: "Priya Raman" },
    });
    await expect(tasks.listParticipantTasks(speakerViewer)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Confirm DevFlow participation" }),
      ]),
    );
  });
});
