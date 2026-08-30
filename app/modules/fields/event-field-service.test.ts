import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type EventFieldDefinitionValue,
  EventFieldService,
} from "./event-field-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function currentFieldForm(fields: readonly EventFieldDefinitionValue[]) {
  const form = new FormData();
  for (const field of fields) {
    if (field.participantAccess !== "editable") continue;
    const name = `field:${field.id}`;
    form.set(`fieldRevision:${field.id}`, String(field.valueRevision));
    if (Array.isArray(field.value)) {
      for (const value of field.value) form.append(name, value);
    } else if (field.value !== null && field.value !== false) {
      form.set(name, String(field.value));
    } else if (field.required) {
      const requiredValue = field.options[0] ?? "Required value";
      form.set(name, field.fieldType === "boolean" ? "true" : requiredValue);
    }
  }
  return form;
}

describe("event-owned participant fields", () => {
  it("enforces profile access and persists typed participant values", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    await service.createDefinition(admin, {
      ownerType: "person",
      fieldKey: `dietary_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
      label: "Dietary requirements",
      fieldType: "short_text",
      options: [],
      participantAccess: "editable",
      required: true,
    });
    const fields = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    const dietary = fields.find(
      (field) => field.label === "Dietary requirements",
    );
    expect(dietary).toMatchObject({
      fieldType: "short_text",
      participantAccess: "editable",
      required: true,
      valueRevision: 0,
      value: null,
    });
    const values = new FormData();
    values.set(`field:${dietary!.id}`, "Vegetarian");
    values.set(`fieldRevision:${dietary!.id}`, "0");
    await service.saveValues(speaker, "person", speaker.personId, values, true);
    await expect(
      service.values(admin, "person", speaker.personId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: dietary!.id,
          value: "Vegetarian",
        }),
      ]),
    );

    const policies = new FormData();
    for (const key of [
      "name",
      "biography",
      "pronunciation",
      "organisation_name",
      "job_title",
      "linkedin_url",
      "x_handle",
      "travel_preferences",
    ]) {
      policies.set(`policy:${key}`, key === "name" ? "read_only" : "editable");
    }
    await service.saveProfilePolicies(admin, policies);
    try {
      const attempted = new FormData();
      attempted.set("name", "Unauthorized rename");
      attempted.set("biography", "Participant-controlled biography");
      const protectedInput = await service.participantProfileInput(
        speaker,
        attempted,
      );
      expect(protectedInput).not.toHaveProperty("name");
      expect(protectedInput.biography).toBe("Participant-controlled biography");
    } finally {
      await testEnv.DB.prepare(
        "DELETE FROM event_participant_field_policies WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .run();
    }
  });

  it("does not allow participant-editable session fields", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await expect(
      new EventFieldService(testEnv).createDefinition(admin, {
        ownerType: "session",
        fieldKey: "participant_override",
        label: "Participant override",
        fieldType: "boolean",
        options: [],
        participantAccess: "editable",
        required: false,
      }),
    ).rejects.toThrow(/hidden or read-only/i);
  });

  it("rejects unknown custom-field choice values instead of discarding them", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const definition = await service.createDefinition(admin, {
      ownerType: "session",
      fieldKey: `topics_${suffix}`,
      label: "Preferred topics",
      fieldType: "multiple_choice",
      options: ["Operations", "Design"],
      participantAccess: "read_only",
      required: false,
    });
    const values = new FormData();
    values.append(`field:${definition.id}`, "Operations");
    values.append(`field:${definition.id}`, "Unconfigured option");
    values.set(`fieldRevision:${definition.id}`, "0");

    await expect(
      service.saveValues(admin, "session", "session-demo-speaker", values),
    ).rejects.toThrow(/choose valid preferred topics options/i);
  });

  it("preserves an optional boolean as unanswered when another field is saved", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const booleanDefinition = await service.createDefinition(admin, {
      ownerType: "person",
      fieldKey: `boolean_${suffix}`,
      label: `Optional boolean ${suffix}`,
      fieldType: "boolean",
      options: [],
      participantAccess: "editable",
      required: false,
    });
    const textDefinition = await service.createDefinition(admin, {
      ownerType: "person",
      fieldKey: `text_${suffix}`,
      label: `Optional text ${suffix}`,
      fieldType: "short_text",
      options: [],
      participantAccess: "editable",
      required: false,
    });
    const loaded = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    const form = currentFieldForm(loaded);
    form.set(`field:${textDefinition.id}`, "Updated text");

    await service.saveValues(speaker, "person", speaker.personId, form, true);

    const saved = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    expect(
      saved.find((field) => field.id === booleanDefinition.id),
    ).toMatchObject({ value: null, valueRevision: 1 });
    expect(saved.find((field) => field.id === textDefinition.id)).toMatchObject(
      {
        value: "Updated text",
        valueRevision: 1,
      },
    );
  });

  it("shows only participant-visible fields for sessions linked to the participant", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const visible = await service.createDefinition(admin, {
      ownerType: "session",
      fieldKey: `arrival_${suffix}`,
      label: `Arrival instructions ${suffix}`,
      fieldType: "short_text",
      options: [],
      participantAccess: "read_only",
      required: false,
    });
    const hidden = await service.createDefinition(admin, {
      ownerType: "session",
      fieldKey: `internal_${suffix}`,
      label: `Internal note ${suffix}`,
      fieldType: "short_text",
      options: [],
      participantAccess: "hidden",
      required: false,
    });
    const values = new FormData();
    values.set(`field:${visible.id}`, "Meet at the green room");
    values.set(`field:${hidden.id}`, "Organiser-only detail");
    values.set(`fieldRevision:${visible.id}`, "0");
    values.set(`fieldRevision:${hidden.id}`, "0");
    await service.saveValues(admin, "session", "session-demo-speaker", values);

    await expect(service.participantSessionValues(speaker)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-demo-speaker",
          id: visible.id,
          value: "Meet at the green room",
        }),
      ]),
    );
    const portal = await new SpeakerService(testEnv).getPortal(speaker);
    const session = portal.sessions.find(
      (candidate) => candidate.id === "session-demo-speaker",
    );
    expect(session?.customFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: visible.id,
          value: "Meet at the green room",
        }),
      ]),
    );
    expect(session?.customFields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: hidden.id })]),
    );
  });

  it("allows accepted membership-only participants to own person fields", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    const suffix = crypto.randomUUID();
    const personId = `membership-field-person-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, created_at, updated_at)
         VALUES (?, ?, 'Membership-only speaker', unixepoch(), unixepoch())`,
      ).bind(personId, `membership-field-${suffix}@example.test`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `membership-field-${suffix}`,
        admin.organisationId,
        admin.eventId,
        personId,
      ),
    ]);
    const definition = await service.createDefinition(admin, {
      ownerType: "person",
      fieldKey: `member_${suffix.replaceAll("-", "").slice(0, 8)}`,
      label: `Membership detail ${suffix}`,
      fieldType: "short_text",
      options: [],
      participantAccess: "editable",
      required: false,
    });
    const membershipViewer: Viewer = {
      ...speaker,
      personId,
      name: "Membership-only speaker",
    };

    const fields = await service.values(
      membershipViewer,
      "person",
      personId,
      true,
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: definition.id, valueRevision: 0 }),
      ]),
    );
    const values = currentFieldForm(fields);
    values.set(`field:${definition.id}`, "Membership-backed value");
    await service.saveValues(
      membershipViewer,
      "person",
      personId,
      values,
      true,
    );

    await expect(service.values(admin, "person", personId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: definition.id,
          value: "Membership-backed value",
          valueRevision: 1,
        }),
      ]),
    );
  });

  it("rejects stale field values and revisions cleared values", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new EventFieldService(testEnv);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const definition = await service.createDefinition(admin, {
      ownerType: "person",
      fieldKey: `concurrency_${suffix}`,
      label: `Concurrent detail ${suffix}`,
      fieldType: "short_text",
      options: [],
      participantAccess: "editable",
      required: false,
    });
    const loaded = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    const first = currentFieldForm(loaded);
    first.set(`field:${definition.id}`, "First committed value");
    const stale = currentFieldForm(loaded);
    stale.set(`field:${definition.id}`, "Stale replacement");
    await service.saveValues(speaker, "person", speaker.personId, first, true);

    await expect(
      service.saveValues(speaker, "person", speaker.personId, stale, true),
    ).rejects.toThrow(/changed after this page loaded/i);

    const afterFirst = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    expect(
      afterFirst.find((field) => field.id === definition.id),
    ).toMatchObject({ value: "First committed value", valueRevision: 1 });
    const clear = currentFieldForm(afterFirst);
    clear.set(`field:${definition.id}`, "");
    await service.saveValues(speaker, "person", speaker.personId, clear, true);
    const afterClear = await service.values(
      speaker,
      "person",
      speaker.personId,
      true,
    );
    expect(
      afterClear.find((field) => field.id === definition.id),
    ).toMatchObject({ value: null, valueRevision: 2 });
  });
});
