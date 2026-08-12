import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_IDENTITIES, ensureDemoData } from "~/platform/demo/seed.server";
import { ensureDemoSubmissionForm } from "./demo-submissions.server";
import { ParticipantApplicationSummaryService } from "./participant-application-summary.server";
import type { Applicant } from "./submission-repository.server";
import { submittedSnapshotSchema } from "./submission-schema";
import { SubmissionService } from "./submission-service.server";

const testEnv = env as unknown as CloudflareEnvironment;
const viewer: Viewer = {
  personId: DEMO_IDENTITIES.submitter.personId,
  name: DEMO_IDENTITIES.submitter.name,
  email: DEMO_IDENTITIES.submitter.email,
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
  await testEnv.DB.prepare(
    `UPDATE form_definitions
        SET closes_at = NULL, submission_limit = NULL
      WHERE event_id = ? AND public_slug = 'form'`,
  )
    .bind(viewer.eventId)
    .run();
});

describe("participant application summary", () => {
  it("offers only forms that can still accept a new application", async () => {
    const service = new ParticipantApplicationSummaryService(testEnv);
    const initial = await service.getWorkspace(viewer);
    expect(
      initial.availableForms.some((form) => form.publicSlug === "form"),
    ).toBe(true);

    await testEnv.DB.prepare(
      `UPDATE form_definitions
          SET closes_at = unixepoch() - 1
        WHERE event_id = ? AND public_slug = 'form'`,
    )
      .bind(viewer.eventId)
      .run();
    await expect(service.getWorkspace(viewer)).resolves.toMatchObject({
      availableForms: [],
    });

    await testEnv.DB.prepare(
      `UPDATE form_definitions
          SET closes_at = NULL
        WHERE event_id = ? AND public_slug = 'form'`,
    )
      .bind(viewer.eventId)
      .run();
    const applicant: Applicant = {
      personId: viewer.personId,
      email: viewer.email,
      name: viewer.name,
      verified: true,
      anonymousDraftId: null,
      biography: "",
      profileRevision: 1,
    };
    const submissionId = await new SubmissionService(testEnv).createDraft(
      "form",
      applicant,
    );
    const version = await testEnv.DB.prepare(
      `SELECT version.id, version.version_number AS versionNumber,
              version.schema_json AS schemaJson
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE submission.id = ? AND submission.event_id = ?`,
    )
      .bind(submissionId, viewer.eventId)
      .first<{ id: string; versionNumber: number; schemaJson: string }>();
    if (!version)
      throw new Error("The test application version was not found.");
    const submittedSnapshot = submittedSnapshotSchema.parse({
      formVersionId: version.id,
      versionNumber: version.versionNumber,
      schema: JSON.parse(version.schemaJson),
      answers: {},
      speakers: [{ name: viewer.name, email: viewer.email, biography: "" }],
      uploads: {},
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE submissions
            SET status = 'submitted', submitted_at = unixepoch(),
                submitted_snapshot_json = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(JSON.stringify(submittedSnapshot), submissionId, viewer.eventId),
      testEnv.DB.prepare(
        `UPDATE form_definitions
            SET submission_limit = 1
          WHERE event_id = ? AND public_slug = 'form'`,
      ).bind(viewer.eventId),
    ]);

    await expect(service.getWorkspace(viewer)).resolves.toMatchObject({
      availableForms: [],
    });

    await testEnv.DB.prepare(
      `UPDATE form_definitions SET status = 'closed'
        WHERE event_id = ? AND public_slug = 'form'`,
    )
      .bind(viewer.eventId)
      .run();
    await expect(
      service.getWorkspace(viewer, submissionId),
    ).resolves.toMatchObject({
      selectedApplication: {
        id: submissionId,
        formStatus: "closed",
        primarySubmitter: true,
      },
    });
    await expect(
      service.getWorkspace(viewer, `missing-${crypto.randomUUID()}`),
    ).rejects.toMatchObject({ status: 404 });
  });
});
