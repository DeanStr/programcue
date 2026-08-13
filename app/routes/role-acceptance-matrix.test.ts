import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { ApiKeyService } from "~/platform/api/api-key-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_IDENTITIES, ensureDemoData } from "~/platform/demo/seed.server";
import { loader as adminTaskFileLoader } from "./admin-task-file-download";
import { loader as adminSpeakerFileLoader } from "./admin-speaker-file-download";
import { loader as administrationApiLoader } from "./api-administration-resources";
import { action as administrationCommandAction } from "./api-administration-command";
import {
  action as participantApiAction,
  loader as participantApiLoader,
} from "./api-participant-resources";
import {
  action as applicationAction,
  loader as applicationLoader,
} from "./application-form";
import { action as assistantAction } from "./assistant";
import { action as contextualAiAction } from "./ai-context-action";
import {
  action as communicationComposerAction,
  loader as communicationComposerLoader,
} from "./communication-composer";
import {
  action as evaluationAction,
  loader as evaluationLoader,
} from "./evaluation-admin";
import { action as eventAction, loader as eventLoader } from "./event-setup";
import { action as multipartAction } from "./file-multipart";
import { loader as reviewFileLoader } from "./review-file-download";
import {
  action as reviewAction,
  loader as reviewLoader,
} from "./review-workbench";
import { loader as speakerLoader } from "./speaker-dashboard";
import { loader as speakerLayoutLoader } from "./speaker-layout";
import { action as speakerAction } from "./speaker-tasks";
import { loader as speakerFileLoader } from "./speaker-file-download";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const organisationId = "org-future-events";
const isolatedEventId = "evt-role-matrix-isolated";
const isolatedOrganisationId = "org-role-matrix-isolated";

type ActorName =
  | "owner"
  | "organisation administrator"
  | "event administrator"
  | "committee chair"
  | "evaluator"
  | "submitter"
  | "speaker"
  | "pending administrator"
  | "revoked administrator"
  | "expired administrator"
  | "cross-organisation administrator"
  | "cross-organisation speaker";

type Actor = {
  name: ActorName;
  cookieRole: keyof typeof DEMO_IDENTITIES;
  selectedEventId: string;
  configure?: () => Promise<void>;
};

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function actorCookie(actor: Actor, extraCookie?: string) {
  return [
    `program_cue_demo_identity=${actor.cookieRole}`,
    `program_cue_event=${actor.selectedEventId}`,
    extraCookie,
  ]
    .filter(Boolean)
    .join("; ");
}

function requestFor(
  actor: Actor,
  path: string,
  init: RequestInit = {},
  extraCookie?: string,
) {
  const headers = new Headers(init.headers);
  headers.set("cookie", actorCookie(actor, extraCookie));
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function routeStatus(operation: Promise<unknown>) {
  try {
    const result = await operation;
    if (result instanceof Response) return result.status;
    if (result && typeof result === "object" && "init" in result) {
      const init = (result as { init?: ResponseInit }).init;
      if (typeof init?.status === "number") return init.status;
    }
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
}

async function resetMemberships() {
  await ensureDemoData(workerEnv);
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-role-matrix-org-admin'",
    ),
    workerEnv.DB.prepare(`
      UPDATE memberships
         SET role = 'owner', event_id = NULL, invited_at = unixepoch(),
             invitation_expires_at = NULL, accepted_at = unixepoch(),
             revoked_at = NULL
       WHERE id = 'membership-demo-owner'
    `),
    workerEnv.DB.prepare(
      `
      UPDATE memberships
         SET role = 'administrator', event_id = ?, invited_at = unixepoch(),
             invitation_expires_at = NULL, accepted_at = unixepoch(),
             revoked_at = NULL
       WHERE id = 'membership-demo-admin'
    `,
    ).bind(eventId),
    ...(["evaluator", "submitter", "speaker"] as const).map((role) =>
      workerEnv.DB.prepare(
        `
        UPDATE memberships
           SET role = ?, event_id = ?, invited_at = unixepoch(),
               invitation_expires_at = NULL, accepted_at = unixepoch(),
               revoked_at = NULL
         WHERE id = ?
      `,
      ).bind(role, eventId, `membership-demo-${role}`),
    ),
    workerEnv.DB.prepare(
      `
      INSERT OR IGNORE INTO organisations (id, name, slug)
      VALUES (?, 'Role matrix isolated organisation', 'role-matrix-isolated')
    `,
    ).bind(isolatedOrganisationId),
    workerEnv.DB.prepare(
      `
      INSERT OR IGNORE INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES (?, ?, 'Role matrix isolated event',
                'role-matrix-isolated-event', 'UTC', 1760000000, 1760086400, ?)
    `,
    ).bind(
      isolatedEventId,
      isolatedOrganisationId,
      CANONICAL_EVENT_FILE_POLICY_JSON,
    ),
  ]);
}

const actors: readonly Actor[] = [
  { name: "owner", cookieRole: "owner", selectedEventId: eventId },
  {
    name: "organisation administrator",
    cookieRole: "administrator",
    selectedEventId: eventId,
    configure: async () => {
      await workerEnv.DB.batch([
        workerEnv.DB.prepare(
          "UPDATE memberships SET revoked_at = unixepoch() WHERE id = 'membership-demo-admin'",
        ),
        workerEnv.DB.prepare(
          `
          INSERT INTO memberships (
            id, organisation_id, event_id, person_id, role,
            invited_at, accepted_at, created_at
          ) VALUES ('membership-role-matrix-org-admin', ?, NULL, ?,
                    'administrator', unixepoch(), unixepoch(), unixepoch())
        `,
        ).bind(organisationId, DEMO_IDENTITIES.administrator.personId),
      ]);
    },
  },
  {
    name: "event administrator",
    cookieRole: "administrator",
    selectedEventId: eventId,
  },
  {
    name: "committee chair",
    cookieRole: "evaluator",
    selectedEventId: eventId,
    configure: async () => {
      await workerEnv.DB.prepare(
        "UPDATE memberships SET role = 'committee_chair' WHERE id = 'membership-demo-evaluator'",
      ).run();
    },
  },
  {
    name: "evaluator",
    cookieRole: "evaluator",
    selectedEventId: eventId,
  },
  {
    name: "submitter",
    cookieRole: "submitter",
    selectedEventId: eventId,
  },
  { name: "speaker", cookieRole: "speaker", selectedEventId: eventId },
  {
    name: "pending administrator",
    cookieRole: "administrator",
    selectedEventId: eventId,
    configure: async () => {
      await workerEnv.DB.prepare(
        `
        UPDATE memberships
           SET accepted_at = NULL, invited_at = unixepoch(),
               invitation_expires_at = unixepoch() + 300, revoked_at = NULL
         WHERE id = 'membership-demo-admin'
      `,
      ).run();
    },
  },
  {
    name: "revoked administrator",
    cookieRole: "administrator",
    selectedEventId: eventId,
    configure: async () => {
      await workerEnv.DB.prepare(
        `
        UPDATE memberships
           SET accepted_at = unixepoch(), revoked_at = unixepoch()
         WHERE id = 'membership-demo-admin'
      `,
      ).run();
    },
  },
  {
    name: "expired administrator",
    cookieRole: "administrator",
    selectedEventId: eventId,
    configure: async () => {
      await workerEnv.DB.prepare(
        `
        UPDATE memberships
           SET accepted_at = NULL, invited_at = unixepoch(), revoked_at = NULL,
               invitation_expires_at = unixepoch() - 1
         WHERE id = 'membership-demo-admin'
      `,
      ).run();
    },
  },
  {
    name: "cross-organisation administrator",
    cookieRole: "administrator",
    selectedEventId: isolatedEventId,
  },
  {
    name: "cross-organisation speaker",
    cookieRole: "speaker",
    selectedEventId: isolatedEventId,
  },
];

const adminActors = new Set<ActorName>([
  "owner",
  "organisation administrator",
  "event administrator",
]);
const evaluationAdminActors = new Set<ActorName>([
  ...adminActors,
  "committee chair",
]);
const reviewActors = new Set<ActorName>([
  ...evaluationAdminActors,
  "evaluator",
]);
const participantActors = new Set<ActorName>(["submitter", "speaker"]);
const allAcceptedActors = new Set<ActorName>([
  ...reviewActors,
  ...participantActors,
]);
const allActors = new Set<ActorName>(actors.map((actor) => actor.name));

type Boundary = {
  name: string;
  allowed: ReadonlySet<ActorName>;
  allowedStatus: number;
  deniedStatus?: number;
  invoke: (actor: Actor, applicantCookie: string | null) => Promise<unknown>;
};

const boundaries: readonly Boundary[] = [
  {
    name: "communication composer loader",
    allowed: adminActors,
    allowedStatus: 200,
    invoke: (actor) =>
      communicationComposerLoader({
        request: requestFor(actor, "/admin/communications/compose"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "communication composer action",
    allowed: adminActors,
    allowedStatus: 400,
    invoke: (actor) =>
      communicationComposerAction({
        request: requestFor(actor, "/admin/communications/compose", {
          method: "POST",
          body: new URLSearchParams({ intent: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "Event Setup loader",
    allowed: adminActors,
    allowedStatus: 200,
    invoke: (actor) =>
      eventLoader({
        request: requestFor(actor, "/admin/event"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "Event Setup action",
    allowed: adminActors,
    allowedStatus: 422,
    invoke: (actor) =>
      eventAction({
        request: requestFor(actor, "/admin/event", {
          method: "POST",
          body: new URLSearchParams({ _intent: "save" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "evaluation administration loader",
    allowed: evaluationAdminActors,
    allowedStatus: 200,
    invoke: (actor) =>
      evaluationLoader({
        request: requestFor(actor, "/admin/review"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "evaluation administration action",
    allowed: evaluationAdminActors,
    allowedStatus: 400,
    invoke: (actor) =>
      evaluationAction({
        request: requestFor(actor, "/admin/review", {
          method: "POST",
          headers: { origin: "http://localhost" },
          body: new URLSearchParams({ intent: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "review workbench loader",
    allowed: reviewActors,
    allowedStatus: 200,
    invoke: (actor) =>
      reviewLoader({
        request: requestFor(actor, "/review/workbench"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "review workbench action",
    allowed: reviewActors,
    allowedStatus: 400,
    invoke: (actor) =>
      reviewAction({
        request: requestFor(actor, "/review/workbench", {
          method: "POST",
          body: new URLSearchParams({ intent: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "participant workspace layout loader",
    allowed: new Set<ActorName>(["speaker", "submitter"]),
    allowedStatus: 200,
    invoke: (actor) =>
      speakerLayoutLoader({
        request: requestFor(actor, "/participant/dashboard"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "participant dashboard data loader",
    allowed: new Set<ActorName>(["speaker", "submitter"]),
    allowedStatus: 200,
    invoke: (actor) =>
      speakerLoader({
        request: requestFor(actor, "/participant/dashboard"),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "participant workspace action",
    allowed: new Set<ActorName>(["speaker", "submitter"]),
    allowedStatus: 400,
    invoke: (actor) =>
      speakerAction({
        request: requestFor(actor, "/participant/tasks", {
          method: "POST",
          body: new URLSearchParams({ intent: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "public application loader",
    allowed: allActors,
    allowedStatus: 200,
    invoke: (actor) =>
      applicationLoader({
        request: requestFor(actor, "/apply/form"),
        params: { slug: "form" },
        context: context(),
      } as never),
  },
  {
    name: "applicant-owned mutation",
    allowed: new Set<ActorName>(["submitter"]),
    allowedStatus: 422,
    deniedStatus: 401,
    invoke: (actor, applicantCookie) =>
      applicationAction({
        request: requestFor(
          actor,
          "/apply/form",
          {
            method: "POST",
            body: new URLSearchParams({ _intent: "withdraw" }),
          },
          applicantCookie ?? undefined,
        ),
        params: { slug: "form" },
        context: context(),
      } as never),
  },
  {
    name: "participant API loader",
    allowed: participantActors,
    allowedStatus: 200,
    invoke: (actor) =>
      participantApiLoader({
        request: requestFor(
          actor,
          `/api/v1/events/${actor.selectedEventId}/participant/profile`,
        ),
        params: { eventId: actor.selectedEventId, resource: "profile" },
        context: context(),
      } as never),
  },
  {
    name: "participant API action",
    allowed: participantActors,
    allowedStatus: 422,
    invoke: (actor) =>
      participantApiAction({
        request: requestFor(
          actor,
          `/api/v1/events/${actor.selectedEventId}/participant/profile`,
          {
            method: "PATCH",
            headers: {
              origin: "http://localhost",
              "content-type": "application/json",
            },
            body: "{}",
          },
        ),
        params: { eventId: actor.selectedEventId, resource: "profile" },
        context: context(),
      } as never),
  },
  {
    name: "browser administration API decision action",
    allowed: evaluationAdminActors,
    allowedStatus: 422,
    invoke: (actor) =>
      administrationCommandAction({
        request: requestFor(
          actor,
          `/api/v1/events/${actor.selectedEventId}/administration/decisions/missing/draft`,
          {
            method: "POST",
            headers: {
              origin: "http://localhost",
              "content-type": "application/json",
            },
            body: "{}",
          },
        ),
        params: {
          eventId: actor.selectedEventId,
          family: "decisions",
          itemId: "missing",
          command: "draft",
        },
        context: context(),
      } as never),
  },
  {
    name: "API-key-only administration loader",
    allowed: new Set<ActorName>(),
    allowedStatus: 200,
    deniedStatus: 401,
    invoke: (actor) =>
      administrationApiLoader({
        request: requestFor(
          actor,
          `/api/v1/events/${actor.selectedEventId}/administration/submissions`,
        ),
        params: {
          eventId: actor.selectedEventId,
          resource: "submissions",
        },
        context: context(),
      } as never),
  },
  {
    name: "generic private multipart action",
    allowed: allAcceptedActors,
    allowedStatus: 400,
    invoke: (actor) =>
      multipartAction({
        request: requestFor(actor, "/files/multipart/initiate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        params: { operation: "initiate" },
        context: context(),
      } as never),
  },
  {
    name: "administrator speaker file loader",
    allowed: adminActors,
    allowedStatus: 404,
    invoke: (actor) =>
      adminSpeakerFileLoader({
        request: requestFor(actor, "/admin/speakers/missing/files/missing"),
        params: { personId: "missing", assetId: "missing" },
        context: context(),
      } as never),
  },
  {
    name: "administrator task-evidence file loader",
    allowed: adminActors,
    allowedStatus: 404,
    invoke: (actor) =>
      adminTaskFileLoader({
        request: requestFor(actor, "/admin/tasks/files/missing/missing"),
        params: { assetId: "missing", versionId: "missing" },
        context: context(),
      } as never),
  },
  {
    name: "review attachment file loader",
    allowed: reviewActors,
    allowedStatus: 404,
    invoke: (actor) =>
      reviewFileLoader({
        request: requestFor(actor, "/review/files/missing"),
        params: { assetId: "missing" },
        context: context(),
      } as never),
  },
  {
    name: "participant-owned file loader",
    allowed: new Set<ActorName>(["speaker", "submitter"]),
    allowedStatus: 423,
    invoke: (actor) =>
      speakerFileLoader({
        request: requestFor(actor, "/participant/files/missing"),
        params: { assetId: "missing" },
        context: context(),
      } as never),
  },
  {
    name: "standalone assistant action",
    allowed: adminActors,
    allowedStatus: 400,
    invoke: (actor) =>
      assistantAction({
        request: requestFor(actor, "/admin/assistant", {
          method: "POST",
          body: new URLSearchParams({ intent: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
  {
    name: "contextual review assistant action",
    allowed: reviewActors,
    allowedStatus: 400,
    invoke: (actor) =>
      contextualAiAction({
        request: requestFor(actor, "/actions/ai/context", {
          method: "POST",
          body: new URLSearchParams({ kind: "unsupported" }),
        }),
        params: {},
        context: context(),
      } as never),
  },
];

async function applicantCookieFor(actor: Actor) {
  if (actor.name !== "submitter") return null;
  await ensureDemoSubmissionForm(workerEnv);
  const service = new SubmissionService(workerEnv);
  const form = await service.getPublicForm("form");
  const requested = await service.applicants.requestCode(
    form,
    DEMO_IDENTITIES.submitter.email,
    "",
  );
  if (!requested.demoCode) {
    throw new Error("The role matrix requires the explicit demo code.");
  }
  const verified = await service.applicants.verifyCode(
    form,
    DEMO_IDENTITIES.submitter.email,
    requested.demoCode,
  );
  return verified.cookie.split(";", 1)[0] ?? null;
}

describe("route-by-role acceptance matrix", () => {
  for (const actor of actors) {
    it(`${actor.name} reaches only its representative route boundaries`, async () => {
      await resetMemberships();
      await actor.configure?.();
      const invitationAuditsBefore =
        actor.name === "pending administrator"
          ? await workerEnv.DB.prepare(
              `
              SELECT COUNT(*) AS count
                FROM audit_events
               WHERE entity_id = 'membership-demo-admin'
                 AND action = 'membership.accepted'
            `,
            ).first<{ count: number }>()
          : null;
      const applicantCookie = await applicantCookieFor(actor);

      for (const boundary of boundaries) {
        const status = await routeStatus(
          boundary.invoke(actor, applicantCookie),
        );
        const expected = boundary.allowed.has(actor.name)
          ? boundary.allowedStatus
          : (boundary.deniedStatus ?? 403);
        expect(status, `${actor.name} -> ${boundary.name}`).toBe(expected);
      }

      if (actor.name === "pending administrator") {
        const [membership, invitationAuditsAfter] = await Promise.all([
          workerEnv.DB.prepare(
            `
            SELECT accepted_at AS acceptedAt
              FROM memberships
             WHERE id = 'membership-demo-admin'
          `,
          ).first<{ acceptedAt: number | null }>(),
          workerEnv.DB.prepare(
            `
            SELECT COUNT(*) AS count
              FROM audit_events
             WHERE entity_id = 'membership-demo-admin'
               AND action = 'membership.accepted'
          `,
          ).first<{ count: number }>(),
        ]);
        expect(membership?.acceptedAt).toBeNull();
        expect(invitationAuditsAfter?.count).toBe(
          Number(invitationAuditsBefore?.count ?? 0),
        );
      }
    });
  }

  it("accepts only a correctly scoped API key at the administration collection", async () => {
    await resetMemberships();
    await ensureDemoSubmissionForm(workerEnv);
    const key = await new ApiKeyService(workerEnv).create(
      {
        ...DEMO_IDENTITIES.owner,
        role: "owner",
        organisationId,
        eventId,
        demo: true,
      },
      {
        name: `Role matrix ${crypto.randomUUID()}`,
        scopes: ["submissions:read"],
        expiresInDays: null,
      },
    );
    const authorised = await administrationApiLoader({
      request: new Request(
        `http://localhost/api/v1/events/${eventId}/administration/submissions`,
        { headers: { authorization: `Bearer ${key.token}` } },
      ),
      params: { eventId, resource: "submissions" },
      context: context(),
    } as never);
    expect(authorised.status).toBe(200);

    const wrongEvent = await administrationApiLoader({
      request: new Request(
        `http://localhost/api/v1/events/${isolatedEventId}/administration/submissions`,
        { headers: { authorization: `Bearer ${key.token}` } },
      ),
      params: { eventId: isolatedEventId, resource: "submissions" },
      context: context(),
    } as never);
    expect(wrongEvent.status).toBe(403);
  });
});
