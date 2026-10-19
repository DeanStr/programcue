import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "./admin-deliverables";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const testEnv = env as unknown as CloudflareEnvironment;
function args(query = "", form?: URLSearchParams, identity = "administrator") {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: testEnv, ctx: {} as ExecutionContext });
  const request = new Request(
    `http://localhost/admin/tasks/deliverables${query}`,
    {
      method: form ? "POST" : "GET",
      headers: {
        cookie: `program_cue_demo_identity=${identity}; ${currentEventCookie(viewer.eventId, testEnv).split(";", 1)[0]}`,
        origin: "http://localhost",
      },
      body: form,
    },
  );
  return {
    request,
    context,
    params: {},
    pattern: "/admin/tasks/deliverables",
    url: new URL(request.url),
  };
}
beforeEach(async () => {
  await ensureDemoSpeakerData(testEnv);
});
async function template() {
  const service = new CommunicationService(testEnv);
  const saved = await service.saveTemplate(viewer, {
    name: `Filtered reminder ${crypto.randomUUID()}`,
    category: "task_reminder",
    subject: "Your event tasks",
    content: {
      body: "Hello {{recipient.name}}, please open your participant portal and complete your outstanding tasks for {{event.name}}.",
      physicalAddress: "Toronto convention centre",
    },
  });
  await service.publishTemplate(viewer, saved.versionId);
  return saved.versionId;
}
describe("deliverables route", () => {
  it("rejects non-admin access and malformed or foreign filters", async () => {
    await expect(loader(args("", undefined, "speaker"))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      loader(args("?state=all&state=overdue")),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      loader(args("?template=foreign-template")),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("creates an editable reminder for the current filtered audience without sending", async () => {
    const version = await template();
    const id = crypto.randomUUID();
    const result = action(
      args(
        "?q=Priya&template=task-template-handbook",
        new URLSearchParams({
          intent: "reminder",
          templateVersionId: version,
          draftId: id,
          manualRecipients: "attacker@elsewhere.com",
        }),
      ),
    );
    await expect(result).rejects.toMatchObject({ status: 302 });
    const draft = await env.DB.prepare(
      "SELECT status,audience_json AS audience FROM communications WHERE id=? AND event_id=?",
    )
      .bind(id, viewer.eventId)
      .first<{ status: string; audience: string }>();
    expect(draft?.status).toBe("draft");
    expect(JSON.parse(draft!.audience).manualRecipients).toContain(
      "priya.speaker@example.com",
    );
    expect(JSON.parse(draft!.audience).manualRecipients).not.toContain(
      "attacker",
    );
    expect(
      await env.DB.prepare(
        "SELECT id FROM operation_jobs WHERE json_extract(payload_json,'$.communicationId')=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("does not prepare reminders for administrator-only speaker tasks", async () => {
    const version = await template();
    const taskId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO task_instances (id,event_id,target_type,target_id,title,task_type,impact,evidence_mode,status)
       SELECT ?,event_id,target_type,target_id,'Organiser approval','administrator_only','medium','admin_approval','not_started'
       FROM task_instances WHERE event_id=? AND template_id='task-template-handbook' AND target_id='person-demo-speaker' LIMIT 1`,
    )
      .bind(taskId, viewer.eventId)
      .run();
    const query = `?q=Priya&template=task:${taskId}`;
    const matrix = await loader(args(query));
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.recipientCount).toBe(0);
    const id = crypto.randomUUID();
    expect(
      await action(
        args(
          query,
          new URLSearchParams({
            intent: "reminder",
            templateVersionId: version,
            draftId: id,
          }),
        ),
      ),
    ).toMatchObject({ data: { ok: false }, init: { status: 422 } });
    expect(
      await env.DB.prepare("SELECT id FROM communications WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("recomputes recipients when tasks are completed after the matrix was loaded", async () => {
    const version = await template();
    const before = await loader(
      args("?q=Priya&template=task-template-handbook"),
    );
    expect(before.recipientCount).toBe(1);
    await env.DB.prepare(
      "UPDATE task_instances SET status='completed' WHERE event_id=? AND template_id='task-template-handbook'",
    )
      .bind(viewer.eventId)
      .run();
    const id = crypto.randomUUID();
    const result = await action(
      args(
        "?q=Priya&template=task-template-handbook",
        new URLSearchParams({
          intent: "reminder",
          templateVersionId: version,
          draftId: id,
        }),
      ),
    );
    expect(result).toMatchObject({
      data: {
        ok: false,
        message:
          "No speakers in these filters have actionable outstanding work.",
      },
      init: { status: 422 },
    });
    expect(
      await env.DB.prepare("SELECT id FROM communications WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  });
});
