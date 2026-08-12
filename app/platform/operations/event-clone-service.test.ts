import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  EventConfigurationDataError,
  INITIAL_EVENT_SESSION_FORMATS_JSON,
  parseSessionFormatsConfiguration,
} from "~/modules/events/event-configuration";
import {
  CANONICAL_EVENT_FILE_POLICY,
  parseEventFilePolicy,
} from "~/modules/files/file-policy";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { PreparedAirtableRepositoryConnection } from "~/modules/airtable/airtable-room-repository.server";
import { EventRepositoryProvisioningService } from "~/modules/events/event-repository-provisioning.server";
import {
  EventCloneConfigurationError,
  EventCloneService,
  EventCloneSlugConflictError,
} from "~/platform/operations/event-clone-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function preparedConnection(): PreparedAirtableRepositoryConnection {
  return {
    connectionId: crypto.randomUUID(),
    encryptedCredentials: '{"version":1,"iv":"test","ciphertext":"test"}',
    configuration: {
      baseId: "app12345678901234",
      schemaVersion: 4,
      tables:
        {} as PreparedAirtableRepositoryConnection["configuration"]["tables"],
      authoritativeEntities: [
        "rooms",
        "event_configuration",
        "forms",
        "submissions",
        "evaluations",
        "sessions",
        "tasks",
        "published_programme",
      ],
    },
  };
}

describe("event cloning", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM task_template_dependencies
          WHERE template_id = 'resource-ack:source-page'
             OR depends_on_template_id = 'resource-ack:source-page'`,
      ),
      env.DB.prepare(
        `DELETE FROM task_templates
          WHERE id = 'resource-ack:source-page' AND event_id = ?`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `UPDATE form_definitions SET confirmation_template_id = NULL
          WHERE id = 'clone-form' AND event_id = ?`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (
           'membership-clone-organisation-admin', ?, NULL, ?,
           'administrator', unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(viewer.organisationId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tracks (id,event_id,name,slug,position) VALUES ('clone-track',?,'Operations','operations',0)",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_templates (id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,auto_assign_on_acceptance,status) VALUES ('clone-task-a',?,'Profile','speaker','checklist','high','none','none',1,'active')",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_templates (id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,fixed_due_at,auto_assign_on_acceptance,status) VALUES ('clone-task-b',?,'Slides','speaker','file_upload','critical','file','fixed',unixepoch()+86400,1,'active')",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_template_dependencies (template_id,depends_on_template_id) VALUES ('clone-task-b','clone-task-a')",
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO communication_templates (id,event_id,name,category,status,created_by_person_id) VALUES ('clone-comm',?,'Reminder','task_reminder','active',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO communication_template_versions (id,event_id,template_id,version_number,name,category,channel,subject_template,content_json,status,created_by_person_id,published_at) VALUES ('clone-comm-v1',?,'clone-comm',1,'Reminder','task_reminder','email','Reminder','{\"type\":\"doc\",\"content\":[]}','published',?,unixepoch())",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO communication_triggers (
           id,event_id,template_id,trigger_type,configuration_json,enabled,
           created_at,updated_at
         ) VALUES (
           'clone-trigger',?,'clone-comm','task_due',
           '{"audienceType":"due_speakers","kind":"transactional","sendHourUtc":9,"lastRunBucket":"2027-05-20"}',
           1,unixepoch(),unixepoch()
         )`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO evaluation_plans (id,event_id,name,status,created_by_person_id) VALUES ('clone-plan',?,'Review plan','active',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO evaluation_rounds (id,event_id,plan_id,round_number,name,status,opens_at,closes_at) VALUES ('clone-round',?,'clone-plan',1,'First round','active',unixepoch(),unixepoch()+86400)",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO evaluation_criteria (id,event_id,round_id,name,input_type,weight_percent,required,position) VALUES ('clone-criterion',?,'clone-round','Fit','scale_5',100,1,0)",
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO form_definitions (id,event_id,name,kind,status,public_slug,closes_at,min_speakers,access_mode,access_password_hash,created_by_person_id) VALUES ('clone-form',?,'Call for speakers','submission','published','clone-form-public',unixepoch()+86400,1,'password_protected','source-password-hash',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        'INSERT OR IGNORE INTO form_versions (id,event_id,form_id,version_number,schema_json,routing_json,settings_snapshot_json,status,published_at,created_by_person_id) VALUES (\'clone-form-v1\',?,\'clone-form\',1,\'{"components":[]}\',\'{"categories":{},"trackIds":{},"trackNames":{},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":"source-password-hash"}\',\'{"publicSlug":"clone-form-public","closesAt":1893456000,"accessMode":"password_protected"}\',\'published\',unixepoch(),?)',
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO form_definitions (id,event_id,name,kind,status,public_slug,min_speakers,access_mode,created_by_person_id) VALUES ('clone-archived-form',?,'Old form','submission','archived','clone-archived-form-public',1,'email_verified',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        'INSERT OR IGNORE INTO form_versions (id,event_id,form_id,version_number,schema_json,routing_json,settings_snapshot_json,status,created_by_person_id) VALUES (\'clone-archived-form-v1\',?,\'clone-archived-form\',1,\'{"components":[]}\',\'{"categories":{},"trackIds":{},"trackNames":{},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":null}\',\'{}\',\'draft\',?)',
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `UPDATE form_versions
            SET routing_json = '{"categories":{},"trackIds":{},"trackNames":{},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":"source-password-hash"}'
          WHERE id = 'clone-form-v1' AND event_id = ?`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO communication_templates (id,event_id,name,category,status,created_by_person_id) VALUES ('clone-archived-comm',?,'Old reminder','task_reminder','archived',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO communication_template_versions (id,event_id,template_id,version_number,name,category,channel,content_json,status,created_by_person_id) VALUES ('clone-archived-comm-v1',?,'clone-archived-comm',1,'Old reminder','task_reminder','email','{\"type\":\"doc\",\"content\":[]}','draft',?)",
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_templates (id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,auto_assign_on_acceptance,status) VALUES ('clone-archived-task',?,'Old task','speaker','checklist','low','none','none',0,'archived')",
      ).bind(viewer.eventId),
    ]);
  });

  it("prepares date-shifted defaults only for the authorised source event", async () => {
    const service = new EventCloneService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(service.prepare(viewer)).resolves.toMatchObject({
      source: {
        name: "Future of Events 2025",
        slug: "future-of-events-2025",
        timezone: "America/Toronto",
      },
      defaults: {
        name: "Future of Events 2025 Copy",
        slug: "future-of-events-2025-copy",
        timezone: "America/Toronto",
        startDate: "2026-05-20",
        endDate: "2026-05-22",
      },
    });

    await expect(
      service.prepare({ ...viewer, organisationId: "org-outside-scope" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps generated clone identity defaults within the accepted limits", async () => {
    const sourceName = "N".repeat(160);
    const sourceSlug = `${"s".repeat(114)}-tailx`;
    await env.DB.prepare("UPDATE events SET name = ?, slug = ? WHERE id = ?")
      .bind(sourceName, sourceSlug, viewer.eventId)
      .run();

    try {
      const prepared = await new EventCloneService(
        env as unknown as CloudflareEnvironment,
      ).prepare(viewer);

      expect(prepared.defaults.name).toBe(`${"N".repeat(155)} Copy`);
      expect(prepared.defaults.name).toHaveLength(160);
      expect(prepared.defaults.slug).toBe(`${"s".repeat(114)}-copy`);
      expect(prepared.defaults.slug).toHaveLength(119);
      expect(prepared.defaults.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    } finally {
      await env.DB.prepare(
        "UPDATE events SET name = 'Future of Events 2025', slug = 'future-of-events-2025' WHERE id = ?",
      )
        .bind(viewer.eventId)
        .run();
    }
  });

  it("copies reusable configuration into a clean draft event", async () => {
    const sourceFilePolicy = {
      ...CANONICAL_EVENT_FILE_POLICY,
      videoMaximumBytes: 256 * 1_048_576,
    };
    const sourceSessionFormats = [
      {
        key: "fireside-chat",
        label: "Fireside chat",
        defaultDurationMinutes: 35,
        position: 0,
      },
      {
        key: "studio-workshop",
        label: "Studio workshop",
        defaultDurationMinutes: 110,
        position: 1,
      },
    ];
    await env.DB.prepare(
      "UPDATE events SET file_policy_json = ?, session_formats_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify(sourceFilePolicy),
        JSON.stringify(sourceSessionFormats),
        viewer.eventId,
      )
      .run();
    const cloned = await new EventCloneService(
      env as unknown as CloudflareEnvironment,
    ).clone(viewer, {
      name: "Future Events Copy",
      slug: "future-events-copy",
      timezone: "America/Toronto",
      startDate: "2027-05-20",
      endDate: "2027-05-22",
      repositoryProvider: "d1",
    });

    expect(cloned.copied).toMatchObject({
      forms: 1,
      formVersions: 1,
      evaluationPlans: 1,
      evaluationRounds: 1,
      evaluationCriteria: 1,
      taskTemplates: 2,
      communicationTemplates: 1,
      communicationTemplateVersions: 1,
    });
    const clonedEvent = await env.DB.prepare(
      "SELECT repository_provider AS provider, last_operation_id AS operationId, file_policy_json AS filePolicyJson, session_formats_json AS sessionFormatsJson FROM events WHERE id = ?",
    )
      .bind(cloned.eventId)
      .first<{
        provider: string;
        operationId: string;
        filePolicyJson: string;
        sessionFormatsJson: string;
      }>();
    expect(clonedEvent).toMatchObject({
      provider: "d1",
      operationId: cloned.operationId,
      filePolicyJson: expect.any(String),
    });
    expect(parseEventFilePolicy(clonedEvent!.filePolicyJson)).toEqual(
      sourceFilePolicy,
    );
    expect(
      parseSessionFormatsConfiguration(clonedEvent!.sessionFormatsJson),
    ).toEqual(sourceSessionFormats);
    expect(
      await env.DB.prepare(
        "SELECT status, closes_at AS closesAt, access_mode AS accessMode, access_password_hash AS passwordHash FROM form_definitions WHERE event_id = ?",
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({
      status: "draft",
      closesAt: null,
      accessMode: "email_verified",
      passwordHash: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT json_extract(v.routing_json, '$.passwordHash') AS passwordHash,
                json_extract(v.settings_snapshot_json, '$.closesAt') AS closesAt,
                json_extract(v.settings_snapshot_json, '$.accessMode') AS accessMode,
                json_extract(v.settings_snapshot_json, '$.publicSlug') = f.public_slug AS slugMatches
           FROM form_versions v
           JOIN form_definitions f ON f.id = v.form_id AND f.event_id = v.event_id
          WHERE v.event_id = ?`,
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({
      passwordHash: null,
      closesAt: null,
      accessMode: "email_verified",
      slugMatches: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT status, opens_at AS opensAt, closes_at AS closesAt FROM evaluation_rounds WHERE event_id = ?",
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({ status: "draft", opensAt: null, closesAt: null });
    expect(
      await env.DB.prepare(
        "SELECT status, published_at AS publishedAt FROM communication_template_versions WHERE event_id = ?",
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({ status: "draft", publishedAt: null });
    const clonedTrigger = await env.DB.prepare(
      `SELECT enabled, configuration_json AS configurationJson
         FROM communication_triggers WHERE event_id = ?`,
    )
      .bind(cloned.eventId)
      .first<{ enabled: number; configurationJson: string }>();
    expect(clonedTrigger?.enabled).toBe(0);
    expect(JSON.parse(clonedTrigger!.configurationJson)).toEqual({
      audienceType: "due_speakers",
      kind: "transactional",
      sendHourUtc: 9,
    });
    expect(
      await env.DB.prepare(
        `SELECT name,due_anchor AS dueAnchor,
                auto_assign_on_acceptance AS autoAssignOnAcceptance
           FROM task_templates WHERE event_id = ? ORDER BY name`,
      )
        .bind(cloned.eventId)
        .all(),
    ).toMatchObject({
      results: [
        {
          name: "Profile",
          dueAnchor: "none",
          autoAssignOnAcceptance: 1,
        },
        {
          name: "Slides",
          dueAnchor: "none",
          autoAssignOnAcceptance: 1,
        },
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM submissions WHERE event_id = ?",
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT role FROM memberships WHERE event_id = ? AND person_id = ?",
      )
        .bind(cloned.eventId, viewer.personId)
        .first(),
    ).toBeNull();
  });

  it("copies only active rooms and leaves retired room history behind", async () => {
    await env.DB.prepare(
      `INSERT INTO rooms (
         id,event_id,name,capacity,resources_json,position,status
       ) VALUES (
         'clone-retired-room',?,'Former venue',40,'[]',99,'retired'
       )`,
    )
      .bind(viewer.eventId)
      .run();
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rooms WHERE event_id = ? AND status = 'active'",
    )
      .bind(viewer.eventId)
      .first<{ count: number }>();

    const cloned = await new EventCloneService(
      env as unknown as CloudflareEnvironment,
    ).clone(viewer, {
      name: "Active Rooms Only Copy",
      slug: "active-rooms-only-copy",
      timezone: "UTC",
      startDate: "2027-08-01",
      endDate: "2027-08-02",
      repositoryProvider: "d1",
    });

    expect(cloned.copied.rooms).toBe(active?.count);
    expect(
      await env.DB.prepare(
        "SELECT id FROM rooms WHERE event_id = ? AND name = 'Former venue'",
      )
        .bind(cloned.eventId)
        .first(),
    ).toBeNull();
  });

  it("can activate Airtable authority after cloned configuration reconciles", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async (_viewer, _eventId, connection) => {
          expect(connection).toEqual({
            personalAccessToken: "pat-test-token-at-least-twenty",
            baseId: "app12345678901234",
            tableName: "Program Cue Rooms",
          });
          return prepared;
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "clone-airtable-sync",
          idempotent: false,
        }),
      },
    });
    const token = crypto.randomUUID().slice(0, 8);

    const cloned = await new EventCloneService(testEnv, {
      provisioning,
    }).clone(viewer, {
      name: `Airtable clone ${token}`,
      slug: `airtable-clone-${token}`,
      timezone: "UTC",
      startDate: "2027-08-01",
      endDate: "2027-08-02",
      repositoryProvider: "airtable",
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
    });

    expect(cloned.repositoryProvider).toBe("airtable");
    expect(
      await env.DB.prepare(
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(cloned.eventId)
        .first(),
    ).toEqual({ provider: "airtable" });
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(cloned.operationId)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("validates Airtable room projection data before committing the clone", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.prepare(
      `UPDATE rooms SET resources_json = '[1]'
        WHERE id = (
          SELECT id FROM rooms WHERE event_id = ? AND status = 'active' LIMIT 1
        )`,
    )
      .bind(viewer.eventId)
      .run();
    let providerCalled = false;
    const slug = `invalid-airtable-clone-${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      new EventCloneService(testEnv, {
        provisioning: {
          provisionAirtable: async () => {
            providerCalled = true;
            throw new Error("provider should not be called");
          },
        },
      }).clone(viewer, {
        name: "Invalid Airtable clone",
        slug,
        timezone: "UTC",
        startDate: "2027-08-01",
        endDate: "2027-08-02",
        repositoryProvider: "airtable",
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      }),
    ).rejects.toThrow("Room 1 contains invalid resource configuration.");
    expect(providerCalled).toBe(false);
    expect(
      await testEnv.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
        .bind(slug)
        .first(),
    ).toBeNull();
  });

  it("rejects malformed Airtable credentials before committing the clone", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const slug = `invalid-airtable-credentials-${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      new EventCloneService(testEnv).clone(viewer, {
        name: "Invalid Airtable credentials clone",
        slug,
        timezone: "UTC",
        startDate: "2027-08-01",
        endDate: "2027-08-02",
        repositoryProvider: "airtable",
        personalAccessToken: "short",
        baseId: "not-a-base",
        tableName: "Program Cue Rooms",
      }),
    ).rejects.toThrow("Enter a valid Airtable personal access token.");
    expect(
      await testEnv.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
        .bind(slug)
        .first(),
    ).toBeNull();
  });

  it("rejects event-scoped administrators without granting access to a new event", async () => {
    const token = crypto.randomUUID();
    const personId = `event-only-clone-admin:${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES (?, ?, 'Event-only administrator', 1, unixepoch(), unixepoch())`,
      ).bind(personId, `${token}@example.test`),
      env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'administrator', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `event-only-clone-membership:${token}`,
        viewer.organisationId,
        viewer.eventId,
        personId,
      ),
    ]);
    const eventAdministrator: Viewer = {
      ...viewer,
      personId,
      email: `${token}@example.test`,
    };
    const slug = `forbidden-clone-${token}`;

    await expect(
      new EventCloneService(env as unknown as CloudflareEnvironment).clone(
        eventAdministrator,
        {
          name: "Forbidden event clone",
          slug,
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "d1",
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first(),
    ).resolves.toBeNull();
  });

  it("clears event-owned form routes before copying isolated configuration", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE form_versions
            SET routing_json = ?
          WHERE id = 'clone-form-v1' AND event_id = ?`,
      ).bind(
        JSON.stringify({
          categories: { Operations: "source-evaluation-team" },
          trackIds: { Operations: "clone-track" },
          trackNames: { "clone-track": "Operations" },
          teamNames: { "source-evaluation-team": "Source review team" },
          directSessionDurationMinutes: 75,
          passwordHash: "source-password-hash",
        }),
        viewer.eventId,
      ),
    ]);

    const cloned = await new EventCloneService(
      env as unknown as CloudflareEnvironment,
    ).clone(viewer, {
      name: "Isolated Configuration Copy",
      slug: "isolated-configuration-copy",
      timezone: "UTC",
      startDate: "2027-07-01",
      endDate: "2027-07-02",
      repositoryProvider: "d1",
    });

    const routing = await env.DB.prepare(
      `SELECT version.routing_json AS routingJson, track.id AS clonedTrackId
         FROM form_versions version
         JOIN tracks track ON track.event_id = version.event_id
          AND track.slug = 'operations'
        WHERE version.event_id = ?`,
    )
      .bind(cloned.eventId)
      .first<{ routingJson: string; clonedTrackId: string }>();
    expect(JSON.parse(routing!.routingJson)).toEqual({
      categories: {},
      trackIds: { Operations: routing!.clonedTrackId },
      trackNames: { [routing!.clonedTrackId]: "Operations" },
      teamNames: {},
      directSessionDurationMinutes: 75,
      passwordHash: null,
    });
    expect(cloned.copied.taskTemplates).toBe(2);
    expect(
      await env.DB.prepare(
        `SELECT id FROM task_templates
          WHERE event_id = ?
            AND json_extract(configuration_json, '$.resourcePageId') IS NOT NULL`,
      )
        .bind(cloned.eventId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM task_template_dependencies dependency
           JOIN task_templates template ON template.id = dependency.template_id
           JOIN task_templates required ON required.id = dependency.depends_on_template_id
          WHERE template.event_id = ? AND required.event_id = ?`,
      )
        .bind(cloned.eventId, cloned.eventId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("fails before cloning a resource-linked acknowledgement task", async () => {
    await env.DB.prepare(
      `INSERT INTO task_templates (
         id,event_id,name,description,target_type,task_type,impact,
         evidence_mode,due_anchor,auto_assign_on_acceptance,
         configuration_json,status
       ) VALUES (
         'resource-ack:source-page',?,'Read source guide','Read it',
         'speaker','acknowledgement','medium','checkbox','none',0,?,'active'
       )`,
    )
      .bind(viewer.eventId, JSON.stringify({ resourcePageId: "source-page" }))
      .run();
    const slug = `resource-task-clone-${crypto.randomUUID()}`;

    await expect(
      new EventCloneService(env as unknown as CloudflareEnvironment).clone(
        viewer,
        {
          name: "Resource task clone",
          slug,
          timezone: "UTC",
          startDate: "2027-07-01",
          endDate: "2027-07-02",
          repositoryProvider: "d1",
        },
      ),
    ).rejects.toThrow(
      new EventCloneConfigurationError(
        "Task template resource-ack:source-page configuration references a resource page, which event cloning does not copy. Remove or archive the generated acknowledgement task before cloning this event.",
      ),
    );
    await expect(
      env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first(),
    ).resolves.toBeNull();
  });

  it("fails before detaching a form from a non-cloneable confirmation template", async () => {
    await env.DB.prepare(
      `UPDATE form_definitions SET confirmation_template_id = 'clone-archived-comm'
        WHERE id = 'clone-form' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const slug = `confirmation-template-clone-${crypto.randomUUID()}`;

    await expect(
      new EventCloneService(env as unknown as CloudflareEnvironment).clone(
        viewer,
        {
          name: "Confirmation template clone",
          slug,
          timezone: "UTC",
          startDate: "2027-07-01",
          endDate: "2027-07-02",
          repositoryProvider: "d1",
        },
      ),
    ).rejects.toThrow(
      new EventCloneConfigurationError(
        "Form clone-form references confirmation template clone-archived-comm, which is not available to clone. Remove the reference or restore the template before cloning this event.",
      ),
    );
    await expect(
      env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first(),
    ).resolves.toBeNull();
  });

  it("relies on an owner's organisation membership instead of creating persistent event access", async () => {
    const owner: Viewer = {
      personId: "person-demo-owner",
      name: "Morgan Lee",
      email: "owner@example.com",
      role: "owner",
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      demo: true,
    };
    const cloned = await new EventCloneService(
      env as unknown as CloudflareEnvironment,
    ).clone(owner, {
      name: "Owner Organisation Scope Copy",
      slug: "owner-organisation-scope-copy",
      timezone: "UTC",
      startDate: "2027-06-01",
      endDate: "2027-06-02",
      repositoryProvider: "d1",
    });

    expect(
      await env.DB.prepare(
        "SELECT id FROM memberships WHERE event_id = ? AND person_id = ?",
      )
        .bind(cloned.eventId, owner.personId)
        .first(),
    ).toBeNull();
    await expect(
      requireEventRole(
        new Request("https://programcue.test/admin/event", {
          headers: { cookie: "program_cue_demo_role=owner" },
        }),
        env as unknown as CloudflareEnvironment,
        cloned.eventId,
        ["owner"],
      ),
    ).resolves.toMatchObject({
      eventId: cloned.eventId,
      organisationId: viewer.organisationId,
      role: "owner",
    });
  });

  it("rejects a duplicate event slug before writing", async () => {
    await expect(
      new EventCloneService(env as unknown as CloudflareEnvironment).clone(
        viewer,
        {
          name: "Duplicate",
          slug: "future-of-events-2025",
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "d1",
        },
      ),
    ).rejects.toBeInstanceOf(EventCloneSlugConflictError);
  });

  it("rejects invalid persisted session formats instead of cloning schema defaults", async () => {
    await env.DB.prepare(
      "UPDATE events SET session_formats_json = '[]' WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();

    await expect(
      new EventCloneService(env as unknown as CloudflareEnvironment).clone(
        viewer,
        {
          name: "Invalid Configuration Copy",
          slug: "invalid-configuration-copy",
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "d1",
        },
      ),
    ).rejects.toBeInstanceOf(EventConfigurationDataError);
    await expect(
      env.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
        .bind("invalid-configuration-copy")
        .first(),
    ).resolves.toBeNull();
  });

  it("recognizes cloned travel onboarding presets without creating duplicates", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.prepare(
      "UPDATE events SET session_formats_json = ? WHERE id = ?",
    )
      .bind(INITIAL_EVENT_SESSION_FORMATS_JSON, viewer.eventId)
      .run();
    await new TaskService(testEnv).createTravelOnboardingTemplates(
      viewer,
      true,
    );
    const token = crypto.randomUUID().slice(0, 8);
    const cloned = await new EventCloneService(testEnv).clone(viewer, {
      name: `Travel preset clone ${token}`,
      slug: `travel-preset-clone-${token}`,
      timezone: "America/Toronto",
      startDate: "2027-05-20",
      endDate: "2027-05-22",
      repositoryProvider: "d1",
    });
    const clonedViewer = { ...viewer, eventId: cloned.eventId };
    const before = await testEnv.DB.prepare(
      `SELECT id, json_extract(configuration_json, '$.preset') AS preset
         FROM task_templates
        WHERE event_id = ?
          AND json_extract(configuration_json, '$.preset') IS NOT NULL
        ORDER BY preset`,
    )
      .bind(cloned.eventId)
      .all<{ id: string; preset: string }>();
    expect(before.results).toHaveLength(2);

    const result = await new TaskService(
      testEnv,
    ).createTravelOnboardingTemplates(clonedViewer, true);

    expect(result.createdTemplateIds).toEqual([]);
    expect(result.flightTemplateId).toBe(before.results[0]?.id);
    expect(result.hotelTemplateId).toBe(before.results[1]?.id);
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_templates
          WHERE event_id = ?
            AND json_extract(configuration_json, '$.preset') IS NOT NULL`,
      )
        .bind(cloned.eventId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 });
  });
});
