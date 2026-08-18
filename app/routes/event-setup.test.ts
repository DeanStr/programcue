import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import type { EventSetup } from "~/modules/events/event-repository.server";
import { EventService } from "~/modules/events/event-service.server";
import { FILE_SIZE_MIB } from "~/modules/files/file-policy";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./event-setup";

const workerEnv = env as unknown as CloudflareEnvironment;
const viewer = {
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
} as const;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(
  role: "owner" | "administrator",
  values?: Record<string, string>,
) {
  return new Request("http://localhost/admin/event", {
    method: values ? "POST" : "GET",
    headers: {
      cookie: `program_cue_demo_identity=${role}; program_cue_event=evt-foe-2025`,
      origin: "http://localhost",
    },
    ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}

function setupValues(event: EventSetup, tracks: unknown = event.tracks) {
  const values: Record<string, string> = {
    _intent: "save",
    revision: String(event.revision),
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    venueAddress: event.venueAddress,
    venueMapUrl: event.venueMapUrl,
    city: event.city,
    publicSlug: event.publicSlug,
    brandAccent: event.brandAccent,
    programmeHeroImageUrl: event.programmeHeroImageUrl,
    participantLogoUrl: event.participantLogoUrl,
    participantWelcomeText: event.participantWelcomeText,
    participantSupportUrl: event.participantSupportUrl,
    description: event.description,
    repositoryProvider: event.repositoryProvider,
    retentionMonths: String(event.retentionMonths),
    submissionAccessMode: event.submissionAccessMode,
    headshotMaximumMegabytes: String(
      event.filePolicy.headshotMaximumBytes / FILE_SIZE_MIB,
    ),
    slidesMaximumMegabytes: String(
      event.filePolicy.slidesMaximumBytes / FILE_SIZE_MIB,
    ),
    supportingDocumentMaximumMegabytes: String(
      event.filePolicy.supportingDocumentMaximumBytes / FILE_SIZE_MIB,
    ),
    videoMaximumMegabytes: String(
      event.filePolicy.videoMaximumBytes / FILE_SIZE_MIB,
    ),
    rooms: JSON.stringify(event.rooms),
    tracks: JSON.stringify(tracks),
    sessionFormats: JSON.stringify(event.sessionFormats),
  };
  if (event.allowAnonymousDrafts) values.allowAnonymousDrafts = "on";
  if (event.duplicatePersonWarnings) values.duplicatePersonWarnings = "on";
  return values;
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("Event Setup administrator scope route", () => {
  it("persists a track without a colour and exposes it to the schedule workspace", async () => {
    const service = new EventService(workerEnv);
    const original = await service.getSetup({
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      demo: true,
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const track = {
      id: `track-route-${suffix}`,
      name: `Route track ${suffix}`,
      slug: `route-track-${suffix}`,
      colourToken: null,
      position: original.tracks.length,
      exclusive: false,
      isPublic: true,
    };

    try {
      const saved = await action({
        request: request("administrator", {
          ...setupValues(original, [...original.tracks, track]),
        }),
        params: {},
        context: context(),
      } as never);
      if (saved instanceof Response)
        throw new Error("Track save returned a raw response.");
      expect(saved.data.intent).toBe("save");
      expect(saved.data.ok || saved.data.committed).toBe(true);

      const reloaded = await loader({
        request: request("administrator"),
        params: {},
        context: context(),
      } as never);
      expect(reloaded.event.tracks).toContainEqual(track);

      const schedule = await new ScheduleService(workerEnv).getWorkspace(
        viewer,
      );
      expect(schedule.tracks).toContainEqual({
        id: track.id,
        name: track.name,
        exclusive: false,
        isPublic: true,
      });
    } finally {
      await workerEnv.DB.prepare(
        "DELETE FROM tracks WHERE event_id = ? AND id = ?",
      )
        .bind(viewer.eventId, track.id)
        .run();
    }
  });

  it("persists an added room through Event Setup and exposes it to scheduling", async () => {
    const service = new EventService(workerEnv);
    const original = await service.getSetup({
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      demo: true,
    });
    const roomName = `Route room ${crypto.randomUUID().slice(0, 8)}`;

    const added = await action({
      request: request("administrator", {
        _intent: "add_room",
        revision: String(original.revision),
        name: roomName,
        capacity: "180",
      }),
      params: {},
      context: context(),
    } as never);
    if (added instanceof Response)
      throw new Error("Room creation returned a raw response.");
    expect(added.data).toMatchObject({
      intent: "add_room",
      message: expect.stringContaining(roomName),
    });
    expect(added.data.ok || added.data.committed).toBe(true);

    try {
      const reloaded = await loader({
        request: request("administrator"),
        params: {},
        context: context(),
      } as never);
      expect(reloaded.event.rooms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: roomName, capacity: 180 }),
        ]),
      );
      const schedule = await new ScheduleService(workerEnv).getWorkspace(
        viewer,
      );
      expect(schedule.rooms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: roomName, capacity: 180 }),
        ]),
      );
    } finally {
      await workerEnv.DB.prepare(
        "DELETE FROM rooms WHERE event_id = ? AND name = ?",
      )
        .bind(viewer.eventId, roomName)
        .run();
    }
  });

  it("returns specific room duplicate and validation errors without persistence", async () => {
    const service = new EventService(workerEnv);
    const original = await service.getSetup({
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      demo: true,
    });
    const existingRoom = original.rooms[0];
    if (!existingRoom) throw new Error("The demo room fixture is unavailable.");

    const duplicate = await action({
      request: request("administrator", {
        _intent: "add_room",
        revision: String(original.revision),
        name: existingRoom.name.toUpperCase(),
        capacity: "180",
      }),
      params: {},
      context: context(),
    } as never);
    if (duplicate instanceof Response)
      throw new Error("Duplicate room returned a raw response.");
    expect(duplicate.init?.status).toBe(409);
    expect(duplicate.data).toMatchObject({
      ok: false,
      intent: "add_room",
      errors: { name: ["A room with that name already exists in this event."] },
    });

    const invalid = await action({
      request: request("administrator", {
        _intent: "add_room",
        revision: String(original.revision),
        name: "",
        capacity: "0",
      }),
      params: {},
      context: context(),
    } as never);
    if (invalid instanceof Response)
      throw new Error("Invalid room returned a raw response.");
    expect(invalid.init?.status).toBe(422);
    expect(invalid.data).toMatchObject({
      ok: false,
      intent: "add_room",
      errors: {
        name: expect.any(Array),
        capacity: expect.any(Array),
      },
    });
  });

  it("returns a specific tracks field error for an invalid colour", async () => {
    const service = new EventService(workerEnv);
    const original = await service.getSetup({
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      demo: true,
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const track = {
      id: `track-invalid-${suffix}`,
      name: "Invalid colour track",
      slug: `invalid-colour-${suffix}`,
      colourToken: "blue",
      position: original.tracks.length,
      exclusive: false,
      isPublic: true,
    };

    const rejected = await action({
      request: request("administrator", {
        ...setupValues(original, [...original.tracks, track]),
      }),
      params: {},
      context: context(),
    } as never);
    if (rejected instanceof Response)
      throw new Error("Invalid track save returned a raw response.");
    expect(rejected.init?.status).toBe(422);
    expect(rejected.data).toMatchObject({
      ok: false,
      intent: "save",
      message: "Choose a valid track colour in #RRGGBB format.",
      errors: {
        tracks: ["Choose a valid track colour in #RRGGBB format."],
      },
    });
    expect(
      await workerEnv.DB.prepare(
        "SELECT 1 FROM tracks WHERE event_id = ? AND id = ?",
      )
        .bind(viewer.eventId, track.id)
        .first(),
    ).toBeNull();
  });

  it("lets an owner invite, list and explicitly revoke an organisation administrator", async () => {
    const invited = await action({
      request: request("owner", {
        _intent: "invite",
        name: "Route Organisation Admin",
        email: "route-org-admin@example.com",
        scope: "organisation",
      }),
      params: {},
      context: context(),
    } as never);
    if (invited instanceof Response)
      throw new Error("Organisation invitation returned a raw response.");
    expect(invited.data.intent).toBe("invite");
    expect(invited.data.ok || invited.data.committed).toBe(true);
    const membership = await env.DB.prepare(
      `
      SELECT membership.id, membership.event_id AS eventId
        FROM memberships membership
        JOIN people person ON person.id = membership.person_id
       WHERE membership.organisation_id = 'org-future-events'
         AND membership.role = 'administrator'
         AND person.email = 'route-org-admin@example.com' COLLATE NOCASE
    `,
    ).first<{ id: string; eventId: string | null }>();
    expect(membership?.eventId).toBeNull();

    const setup = await loader({
      request: request("owner"),
      params: {},
      context: context(),
    } as never);
    expect(setup.canManageOrganisationAdministrators).toBe(true);
    expect(setup.event.administrators).toContainEqual(
      expect.objectContaining({
        id: membership?.id,
        scope: "organisation",
        status: "Invited",
      }),
    );

    const revoked = await action({
      request: request("owner", {
        _intent: "revoke_administrator",
        membershipId: membership?.id ?? "",
      }),
      params: {},
      context: context(),
    } as never);
    if (revoked instanceof Response)
      throw new Error("Administrator revocation returned a raw response.");
    expect(revoked.data.intent).toBe("revoke_administrator");
    expect(revoked.data.ok || revoked.data.committed).toBe(true);
    const state = await env.DB.prepare(
      "SELECT revoked_at AS revokedAt FROM memberships WHERE id = ?",
    )
      .bind(membership!.id)
      .first<{ revokedAt: number | null }>();
    expect(state?.revokedAt).toBeTypeOf("number");
  });

  it("allows event-only invitation by an event administrator but rejects organisation scope", async () => {
    const eventInvite = await action({
      request: request("administrator", {
        _intent: "invite",
        name: "Route Event Admin",
        email: "route-event-admin@example.com",
        scope: "event",
      }),
      params: {},
      context: context(),
    } as never);
    if (eventInvite instanceof Response)
      throw new Error("Event invitation returned a raw response.");
    expect(eventInvite.data.intent).toBe("invite");
    expect(eventInvite.data.ok || eventInvite.data.committed).toBe(true);
    const eventMembership = await env.DB.prepare(
      `
      SELECT membership.event_id AS eventId
        FROM memberships membership
        JOIN people person ON person.id = membership.person_id
       WHERE person.email = 'route-event-admin@example.com' COLLATE NOCASE
         AND membership.role = 'administrator'
    `,
    ).first<{ eventId: string | null }>();
    expect(eventMembership?.eventId).toBe("evt-foe-2025");

    const forbidden = await action({
      request: request("administrator", {
        _intent: "invite",
        name: "Forbidden Route Organisation Admin",
        email: "forbidden-route-org-admin@example.com",
        scope: "organisation",
      }),
      params: {},
      context: context(),
    } as never);
    if (forbidden instanceof Response)
      throw new Error("Forbidden invitation returned a raw response.");
    expect(forbidden.init?.status).toBe(403);
    expect(forbidden.data).toMatchObject({ ok: false, intent: "invite" });
    expect(
      await env.DB.prepare(
        `
        SELECT 1 FROM memberships membership
        JOIN people person ON person.id = membership.person_id
        WHERE person.email = 'forbidden-route-org-admin@example.com' COLLATE NOCASE
      `,
      ).first(),
    ).toBeNull();
  });

  it("rejects non-POST mutation methods", async () => {
    await expect(
      action({
        request: new Request("http://localhost/admin/event", {
          method: "PUT",
          headers: {
            cookie:
              "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
            origin: "http://localhost",
          },
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 405 });
  });
});
