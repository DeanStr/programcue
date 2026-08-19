import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashApplicantToken } from "~/modules/submissions/applicant-session.server";
import { verifyApplicationNotice } from "~/modules/submissions/application-notice.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import {
  acceptedParticipantManagementHref,
  action,
  applicationDraftHref,
  claimApplicantVideoUploadOperation,
  loader,
} from "./application-form";

function context(
  environment: CloudflareEnvironment = env as unknown as CloudflareEnvironment,
) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

function responseCookiePairs(response: Response) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return (headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""])
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0]!);
}

async function productionEvaluationEnvironment() {
  const environment = {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
    BETTER_AUTH_SECRET:
      "evaluation-applicant-auth-secret-with-more-than-thirty-two-characters",
    TURNSTILE_SITE_KEY: "evaluation-turnstile-site-key",
    TURNSTILE_SECRET_KEY: "evaluation-turnstile-secret-key",
  } as CloudflareEnvironment;
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id,
       actor_id, action, entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, 'org-future-events',
               'evt-foe-2025', 'test-operator', 'evaluation.fixture.reset',
               'event', 'evt-foe-2025', '{}', unixepoch())`,
  )
    .bind(crypto.randomUUID())
    .run();
  return environment;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
  await env.DB.prepare(
    `UPDATE events SET allow_anonymous_drafts = 1
      WHERE id = 'evt-foe-2025'`,
  ).run();
});

describe("public application mutations", () => {
  describe("applicant and co-speaker access", () => {
    it("routes accepted participant management through the exact event selector", () => {
      expect(
        acceptedParticipantManagementHref(
          "event-with-multiple-roles",
          "submitted-proposal",
        ),
      ).toBe(
        "/events/select?eventId=event-with-multiple-roles&returnTo=%2Fparticipant%2Fapplications%3Fapplication%3Dsubmitted-proposal%23participant-application-detail",
      );
    });

    it("opens a closed form only for an exact co-speaker claim token", async () => {
      const form = await env.DB.prepare(
        `SELECT form.id, form.event_id AS eventId, version.id AS versionId
         FROM form_definitions form
         JOIN form_versions version
           ON version.form_id = form.id AND version.event_id = form.event_id
        WHERE form.public_slug = 'form' AND version.status = 'published'
        LIMIT 1`,
      ).first<{ id: string; eventId: string; versionId: string }>();
      if (!form) throw new Error("Published demo form is missing.");
      const submission = {
        id: crypto.randomUUID(),
        title: "Closed-form claim proposal",
      };
      const speakerId = crypto.randomUUID();
      const rawToken = crypto.randomUUID() + crypto.randomUUID();
      const tokenHash = await hashApplicantToken(
        `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
      );
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO submissions (
           id, event_id, form_version_id, public_reference, title, status,
           answers_json, submitted_snapshot_json, submitted_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'submitted', '{}', '{}', unixepoch(),
                   unixepoch(), unixepoch())`,
        ).bind(
          submission.id,
          form.eventId,
          form.versionId,
          `CLAIM-${submission.id}`,
          submission.title,
        ),
        env.DB.prepare(
          `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind, created_at
         ) VALUES (?, ?, ?, ?, 1, '{}', ?, 'submitted', unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          submission.id,
          form.versionId,
          JSON.stringify([
            {
              name: "Closed-form invitee",
              email: `closed-claim-${speakerId}@example.com`,
              biography: "Biography supplied with the invitation.",
            },
          ]),
        ),
        env.DB.prepare(
          `INSERT INTO submission_speakers (
           id, event_id, submission_id, email, display_name, role_label,
           position, invitation_status, is_primary, claim_token_hash,
           invitation_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'Closed-form invitee', 'Co-speaker',
                   99, 'sent', 0, ?, unixepoch() + 3600,
                   unixepoch(), unixepoch())`,
        ).bind(
          speakerId,
          form.eventId,
          submission.id,
          `closed-claim-${speakerId}@example.com`,
          tokenHash,
        ),
        env.DB.prepare(
          `UPDATE form_definitions SET status = 'closed'
          WHERE id = ? AND event_id = ?`,
        ).bind(form.id, form.eventId),
      ]);

      await expect(
        loader({
          request: new Request("http://localhost/apply/form"),
          params: { slug: "form" },
          context: context(),
        } as never),
      ).rejects.toMatchObject({ status: 404 });

      const result = await loader({
        request: new Request(
          `http://localhost/apply/form?${new URLSearchParams({ claim: rawToken, speaker: speakerId })}`,
        ),
        params: { slug: "form" },
        context: context(),
      } as never);
      if (result instanceof Response || "data" in result) {
        throw new Error("Expected the token-bound claim payload.");
      }
      expect(result.claim).toMatchObject({
        id: speakerId,
        displayName: "Closed-form invitee",
        submissionTitle: submission.title,
        expired: false,
      });
      expect(result.availability).toEqual({
        accepting: false,
        reason: "Applications for this event are closed.",
        state: "closed",
      });
      const invalidClaim = await loader({
        request: new Request(
          `http://localhost/apply/form?${new URLSearchParams({ claim: "wrong-token", speaker: speakerId })}`,
        ),
        params: { slug: "form" },
        context: context(),
      } as never);
      if (invalidClaim instanceof Response || !("data" in invalidClaim)) {
        throw new Error("Expected the bounded unavailable claim response.");
      }
      expect(invalidClaim.init?.status).toBe(404);
      expect(invalidClaim.data).toEqual({
        unavailable: "This co-speaker invitation is unavailable.",
      });

      await expect(
        action({
          request: new Request("http://localhost/apply/form", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: "http://localhost",
            },
            body: new URLSearchParams({
              _intent: "update_profile",
              revision: "1",
              name: "Not authorised",
              biography: "A closed form must not accept this.",
            }),
          }),
          params: { slug: "form" },
          context: context(),
        } as never),
      ).rejects.toMatchObject({ status: 404 });

      const crossOriginClaim = await action({
        request: new Request(
          `http://localhost/apply/form?${new URLSearchParams({ claim: rawToken, speaker: speakerId })}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: "https://attacker.example",
            },
            body: new URLSearchParams({
              _intent: "claim_token",
              speakerId,
              claimToken: rawToken,
            }),
          },
        ),
        params: { slug: "form" },
        context: context(),
      } as never);
      expect(crossOriginClaim).toBeInstanceOf(Response);
      expect((crossOriginClaim as Response).status).toBe(403);
      expect(
        (crossOriginClaim as Response).headers.get("set-cookie"),
      ).toBeNull();

      const claimed = await action({
        request: new Request(
          `http://localhost/apply/form?${new URLSearchParams({ claim: rawToken, speaker: speakerId })}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: "http://localhost",
            },
            body: new URLSearchParams({
              _intent: "claim_token",
              speakerId,
              claimToken: rawToken,
            }),
          },
        ),
        params: { slug: "form" },
        context: context(),
      } as never);
      expect(claimed).toBeInstanceOf(Response);
      const claimResponse = claimed as Response;
      expect(claimResponse.status).toBe(302);
      const claimCookie = claimResponse.headers
        .get("set-cookie")!
        .split(";")[0]!;
      const claimDestination = new URL(
        claimResponse.headers.get("location")!,
        "http://localhost",
      );
      expect(claimDestination.searchParams.get("claimedSpeaker")).toBe(
        speakerId,
      );

      const updated = await action({
        request: new Request(claimDestination, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: claimCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "update_profile",
            revision: "1",
            name: "Claimed speaker",
            biography: "Biography owned by the claimed speaker.",
          }),
        }),
        params: { slug: "form" },
        context: context(),
      } as never);
      expect(updated).toBeInstanceOf(Response);
      const updateResponse = updated as Response;
      expect(updateResponse.status).toBe(302);
      const updateDestination = new URL(
        updateResponse.headers.get("location")!,
        "http://localhost",
      );
      expect(updateDestination.searchParams.get("claimedSpeaker")).toBe(
        speakerId,
      );
      await expect(
        env.DB.prepare(
          `SELECT person.display_name AS displayName, person.biography
           FROM submission_speakers speaker
           JOIN people person ON person.id = speaker.person_id
          WHERE speaker.id = ? AND speaker.event_id = ?`,
        )
          .bind(speakerId, form.eventId)
          .first(),
      ).resolves.toEqual({
        displayName: "Claimed speaker",
        biography: "Biography owned by the claimed speaker.",
      });

      const claimedPerson = await env.DB.prepare(
        `SELECT person_id AS personId, email, display_name AS displayName
         FROM submission_speakers WHERE id = ? AND event_id = ?`,
      )
        .bind(speakerId, form.eventId)
        .first<{ personId: string; email: string; displayName: string }>();
      if (!claimedPerson?.personId) {
        throw new Error("The claimed speaker identity is missing.");
      }
      const draftId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO submissions (
           id, event_id, form_version_id, submitter_person_id,
           public_reference, title, status, answers_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'Historical claimed draft', 'draft', '{}',
                   unixepoch(), unixepoch())`,
        ).bind(
          draftId,
          form.eventId,
          form.versionId,
          claimedPerson.personId,
          `DRAFT-${draftId}`,
        ),
        env.DB.prepare(
          `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind,
           saved_by_person_id, created_at
         ) VALUES (?, ?, ?, ?, 1, '{}', ?, 'manual', ?, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          draftId,
          form.versionId,
          JSON.stringify([
            {
              name: claimedPerson.displayName,
              email: claimedPerson.email,
              biography: "Claimed draft biography.",
            },
          ]),
          claimedPerson.personId,
        ),
        env.DB.prepare(
          `INSERT INTO submission_speakers (
           id, event_id, submission_id, person_id, email, display_name,
           role_label, position, invitation_status, is_primary,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'Primary speaker', 0, 'claimed', 1,
                   unixepoch(), unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          draftId,
          claimedPerson.personId,
          claimedPerson.email,
          claimedPerson.displayName,
        ),
      ]);
      expect(applicationDraftHref(draftId, speakerId)).toBe(
        `?claimedSpeaker=${encodeURIComponent(speakerId)}&draft=${encodeURIComponent(draftId)}`,
      );
      const historicalDraftPortal = await loader({
        request: new Request(
          `http://localhost/apply/form${applicationDraftHref(draftId, speakerId)}`,
          { headers: { cookie: claimCookie } },
        ),
        params: { slug: "form" },
        context: context(),
      } as never);
      if (
        historicalDraftPortal instanceof Response ||
        "data" in historicalDraftPortal
      ) {
        throw new Error("Expected the claim-scoped historical draft portal.");
      }
      expect(historicalDraftPortal.selected).toMatchObject({
        id: draftId,
        status: "draft",
      });
      for (const [intent, values] of [
        ["create_draft", { intentId: crypto.randomUUID() }],
        [
          "save_draft",
          {
            submissionId: draftId,
            revision: "1",
            answers: "{}",
            speakers: "[]",
            uploads: "{}",
          },
        ],
        [
          "submit",
          {
            submissionId: draftId,
            revision: "1",
            answers: "{}",
            speakers: "[]",
            uploads: "{}",
            confirm: "yes",
          },
        ],
      ] as const) {
        await expect(
          action({
            request: new Request(updateDestination, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie: claimCookie,
                origin: "http://localhost",
              },
              body: new URLSearchParams({ _intent: intent, ...values }),
            }),
            params: { slug: "form" },
            context: context(),
          } as never),
        ).rejects.toMatchObject({ status: 404 });
      }

      const signedOut = await action({
        request: new Request(updateDestination, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: claimCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({ _intent: "sign_out" }),
        }),
        params: { slug: "form" },
        context: context(),
      } as never);
      expect(signedOut).toBeInstanceOf(Response);
      expect((signedOut as Response).status).toBe(302);
      expect((signedOut as Response).headers.get("location")).toBe("/");
      expect((signedOut as Response).headers.get("set-cookie")).toContain(
        "Max-Age=0",
      );
      await expect(
        loader({
          request: new Request(updateDestination, {
            headers: { cookie: claimCookie },
          }),
          params: { slug: "form" },
          context: context(),
        } as never),
      ).rejects.toMatchObject({ status: 404 });

      await env.DB.prepare(
        `UPDATE form_definitions SET status = 'published'
        WHERE id = ? AND event_id = ?`,
      )
        .bind(form.id, form.eventId)
        .run();
    });
  });

  describe("inactive events", () => {
    it("does not serve or mutate a CFP after the event is deactivated", async () => {
      await env.DB.prepare(
        `UPDATE events SET activation_status = 'discarded'
          WHERE id = 'evt-foe-2025'`,
      ).run();
      try {
        await expect(
          loader({
            request: new Request("http://localhost/apply/form"),
            params: { slug: "form" },
            context: context(),
          } as never),
        ).rejects.toMatchObject({ status: 404 });
      } finally {
        await env.DB.prepare(
          `UPDATE events SET activation_status = 'active'
            WHERE id = 'evt-foe-2025'`,
        ).run();
      }
    });
  });

  describe("published navigation", () => {
    it("describes the separate public applicant context while evaluation access is active", async () => {
      const environment = await productionEvaluationEnvironment();

      for (const [identity, identityLabel] of [
        [null, null],
        ["organizer", "Event organiser"],
      ] as const) {
        const result = await loader({
          request: new Request("https://example.com/apply/form", {
            headers: {
              cookie: (
                await evaluationSessionCookie(environment, identity)
              ).split(";", 1)[0],
            },
          }),
          params: { slug: "form" },
          context: context(environment),
        } as never);
        if (result instanceof Response || "data" in result) {
          throw new Error("Expected the evaluation public form payload.");
        }
        expect(result.evaluationApplicantContext).toEqual({ identityLabel });
        expect(result.applicant).toBeNull();
      }
    });

    it.each([
      ["gate-only", null],
      ["organiser", "organizer" as const],
    ])(
      "reopens the anonymous draft created under a %s evaluation session",
      async (_label, identity) => {
        const environment = await productionEvaluationEnvironment();
        const evaluationCookie = (
          await evaluationSessionCookie(environment, identity)
        ).split(";", 1)[0]!;
        const loaded = await loader({
          request: new Request("https://example.com/apply/form", {
            headers: { cookie: evaluationCookie },
          }),
          params: { slug: "form" },
          context: context(environment),
        } as never);
        if (loaded instanceof Response || "data" in loaded) {
          throw new Error("Expected the evaluation public form payload.");
        }
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request) => {
            if (String(input).includes("challenges.cloudflare.com")) {
              return Response.json({
                success: true,
                hostname: "example.com",
                action: "application_start_anonymous",
              });
            }
            throw new Error(`Unexpected request to ${String(input)}`);
          }),
        );

        const started = await action({
          request: new Request("https://example.com/apply/form", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "cf-connecting-ip":
                identity === null ? "203.0.113.171" : "203.0.113.172",
              cookie: evaluationCookie,
              origin: "https://example.com",
            },
            body: new URLSearchParams({
              _intent: "start_anonymous",
              intentId: `${loaded.intentId}:anonymous`,
              "turnstile-token": "evaluation-public-application-token",
            }),
          }),
          params: { slug: "form" },
          context: context(environment),
        } as never);
        expect(started).toBeInstanceOf(Response);
        const response = started as Response;
        expect(response.status).toBe(302);
        const applicantCookie = responseCookiePairs(response).find((cookie) =>
          cookie.startsWith("__Host-pc_applicant_"),
        );
        if (!applicantCookie) {
          throw new Error("Expected the anonymous applicant cookie.");
        }

        const reopened = await loader({
          request: new Request(
            new URL(response.headers.get("location")!, "https://example.com"),
            {
              headers: {
                cookie: `${evaluationCookie}; ${applicantCookie}`,
              },
            },
          ),
          params: { slug: "form" },
          context: context(environment),
        } as never);
        if (reopened instanceof Response || "data" in reopened) {
          throw new Error("Expected the reopened anonymous draft payload.");
        }
        expect(reopened.applicant).toMatchObject({
          verified: false,
          anonymousDraftId: reopened.selected?.id,
        });
        expect(reopened.selected?.status).toBe("draft");
        expect(reopened.notice).toBe("Your private draft has been created.");
      },
    );

    it("keeps published programme navigation independent of the speaker showcase", async () => {
      const publishedVersion = await env.DB.prepare(
        `SELECT id, schema_json AS schemaJson
         FROM form_versions
        WHERE event_id = 'evt-foe-2025' AND status = 'published'
        ORDER BY version_number DESC
        LIMIT 1`,
      ).first<{ id: string; schemaJson: string }>();
      if (!publishedVersion) throw new Error("Published demo form is missing.");

      const schema = JSON.parse(publishedVersion.schemaJson) as {
        presentation: { showFeaturedSpeakers: boolean };
      };
      schema.presentation.showFeaturedSpeakers = false;
      await env.DB.prepare(
        `UPDATE form_versions SET schema_json = ? WHERE id = ?`,
      )
        .bind(JSON.stringify(schema), publishedVersion.id)
        .run();

      const result = await loader({
        request: new Request("http://localhost/apply/form"),
        params: { slug: "form" },
        context: context(),
      } as never);
      if (result instanceof Response || "data" in result) {
        throw new Error("Expected the public application landing payload.");
      }

      expect(result.programmeUrl).toBe(
        "/public/programme/future-of-events-2027",
      );
      expect(result.featuredSpeakers).toEqual([]);
    });
  });

  describe("upload admission", () => {
    it("admits one applicant video upload operation and blocks sessions awaiting cleanup", () => {
      const uploadOperation: { current: symbol | null } = { current: null };
      const cancellationOperation: { current: symbol | null } = {
        current: null,
      };

      const first = claimApplicantVideoUploadOperation(
        uploadOperation,
        cancellationOperation,
        false,
      );
      expect(first).toBeTypeOf("symbol");
      expect(
        claimApplicantVideoUploadOperation(
          uploadOperation,
          cancellationOperation,
          false,
        ),
      ).toBeNull();

      uploadOperation.current = null;
      expect(
        claimApplicantVideoUploadOperation(
          uploadOperation,
          cancellationOperation,
          true,
        ),
      ).toBeNull();

      cancellationOperation.current = Symbol("cancelling");
      expect(
        claimApplicantVideoUploadOperation(
          uploadOperation,
          cancellationOperation,
          false,
        ),
      ).toBeNull();
    });
  });

  describe("committed lifecycle effects", () => {
    it("emits created, submitted and withdrawn webhooks after each committed lifecycle change", async () => {
      const queuedMessages: unknown[] = [];
      const testEnv = {
        ...(env as unknown as CloudflareEnvironment),
        OPERATIONS_QUEUE: {
          send: async (message: unknown) => {
            queuedMessages.push(message);
          },
        },
      } as unknown as CloudflareEnvironment;
      const endpointId = `application-webhook-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_at, updated_at
       ) VALUES (?, 'org-future-events', 'evt-foe-2025',
                 'Application events', 'https://hooks.example.com/program-cue',
                 'unused-test-ciphertext',
                 '["submission.created","submission.submitted","submission.updated","submission.withdrawn"]',
                 'active',
                 unixepoch(), unixepoch())`,
      )
        .bind(endpointId)
        .run();

      const response = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "start_anonymous",
            intentId: crypto.randomUUID(),
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      expect(response).toBeInstanceOf(Response);
      const redirectResponse = response as Response;
      expect(redirectResponse.status).toBe(302);
      expect(redirectResponse.headers.get("set-cookie")).toContain(
        "pc_applicant_",
      );
      const destination = new URL(
        redirectResponse.headers.get("location")!,
        "http://localhost",
      );
      const submissionId = destination.searchParams.get("draft");
      expect(submissionId).toBeTruthy();
      if (!submissionId) throw new Error("The draft redirect omitted its ID.");
      await expect(
        verifyApplicationNotice(
          testEnv,
          destination.searchParams.get("notice"),
          "form",
        ),
      ).resolves.toMatchObject({
        kind: "created",
        submissionId,
        webhookWarning: false,
      });
      const anonymousCookie = redirectResponse.headers
        .get("set-cookie")!
        .split(";")[0]!;
      const email = `lifecycle-${crypto.randomUUID()}@example.com`;
      const applicationPayload = {
        submissionId,
        revision: "1",
        answers: JSON.stringify({
          title: "Lifecycle webhook contract",
          description: "Exercise every public application lifecycle event.",
          category: ["AI & Innovation"],
          format: "Presentation",
          video: "https://example.com/lifecycle-video",
        }),
        speakers: JSON.stringify([
          {
            name: "Lifecycle Applicant",
            email,
            biography: "Tests the durable public lifecycle contract.",
          },
        ]),
        uploads: "{}",
      };

      const saved = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: anonymousCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "save_draft",
            ...applicationPayload,
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      expect(saved).toBeInstanceOf(Response);

      const codeRequested = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: anonymousCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({ _intent: "request_code", email }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      if (codeRequested instanceof Response) {
        throw new Error("Verification-code request unexpectedly redirected.");
      }
      expect(codeRequested.data).toMatchObject({
        ok: true,
        demoCode: "424242",
      });

      const verified = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: anonymousCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "verify_code",
            email,
            code: "424242",
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      expect(verified).toBeInstanceOf(Response);
      const verifiedCookie = (verified as Response).headers
        .get("set-cookie")!
        .split(";")[0]!;
      const savedRow = await env.DB.prepare(
        `SELECT revision FROM submissions WHERE id = ? AND event_id = 'evt-foe-2025'`,
      )
        .bind(submissionId)
        .first<{ revision: number }>();

      const submitted = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: verifiedCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "submit",
            confirm: "yes",
            ...applicationPayload,
            revision: String(savedRow!.revision),
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      if (submitted instanceof Response) {
        throw new Error("Queue-failed submission unexpectedly redirected.");
      }
      expect(submitted.init?.status).toBe(207);
      expect(submitted.data).toMatchObject({
        ok: false,
        committed: true,
        submissionId,
      });
      const submittedRow = await env.DB.prepare(
        `SELECT revision, status FROM submissions
        WHERE id = ? AND event_id = 'evt-foe-2025'`,
      )
        .bind(submissionId)
        .first<{ revision: number; status: string }>();
      expect(submittedRow?.status).toBe("submitted");

      const revisedDescription =
        "Exercise every public application lifecycle event. Updated: now includes 2026 benchmark data.";
      const crossOriginRevision = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: verifiedCookie,
            origin: "https://attacker.example",
          },
          body: new URLSearchParams({
            _intent: "revise_submission",
            intentId: crypto.randomUUID(),
            confirmRevision: "yes",
            ...applicationPayload,
            revision: String(submittedRow!.revision),
            answers: JSON.stringify({
              ...JSON.parse(applicationPayload.answers),
              description: revisedDescription,
            }),
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      expect(crossOriginRevision).toBeInstanceOf(Response);
      expect((crossOriginRevision as Response).status).toBe(403);
      await expect(
        env.DB.prepare(
          `SELECT revision, status FROM submissions
          WHERE id = ? AND event_id = 'evt-foe-2025'`,
        )
          .bind(submissionId)
          .first(),
      ).resolves.toEqual(submittedRow);

      const revised = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: verifiedCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "revise_submission",
            intentId: crypto.randomUUID(),
            confirmRevision: "yes",
            ...applicationPayload,
            revision: String(submittedRow!.revision),
            answers: JSON.stringify({
              ...JSON.parse(applicationPayload.answers),
              description: revisedDescription,
            }),
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      if (revised instanceof Response) {
        throw new Error(
          "Partially delivered revision unexpectedly redirected.",
        );
      }
      expect(revised.init?.status).toBe(207);
      expect(revised.data).toMatchObject({
        committed: true,
        submissionId,
        revision: submittedRow!.revision + 1,
      });
      const revisedRow = await env.DB.prepare(
        `SELECT revision, status, submitted_snapshot_json AS snapshotJson
         FROM submissions
        WHERE id = ? AND event_id = 'evt-foe-2025'`,
      )
        .bind(submissionId)
        .first<{ revision: number; status: string; snapshotJson: string }>();
      expect(revisedRow?.status).toBe("submitted");
      expect(JSON.parse(revisedRow!.snapshotJson).answers.description).toBe(
        revisedDescription,
      );

      const withdrawn = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: verifiedCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "withdraw",
            submissionId,
            revision: String(revisedRow!.revision),
            confirmWithdrawal: "yes",
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      if (withdrawn instanceof Response) {
        throw new Error("Queue-failed withdrawal unexpectedly redirected.");
      }
      expect(withdrawn.init?.status).toBe(207);
      expect(withdrawn.data).toMatchObject({
        ok: false,
        committed: true,
        submissionId,
      });
      const withdrawalReplay = await action({
        request: new Request("http://localhost/apply/form", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: verifiedCookie,
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "withdraw",
            submissionId,
            revision: String(revisedRow!.revision),
            confirmWithdrawal: "yes",
          }),
        }),
        params: { slug: "form" },
        context: context(testEnv),
      } as never);
      if (withdrawalReplay instanceof Response) {
        throw new Error(
          "Queue-failed withdrawal replay unexpectedly redirected.",
        );
      }
      expect(withdrawalReplay.data).toMatchObject({
        committed: true,
        submissionId,
      });

      const deliveries = await env.DB.prepare(
        `SELECT event_type AS eventType, entity_type AS entityType,
              entity_id AS entityId, idempotency_key AS idempotencyKey,
              payload_json AS payloadJson
         FROM webhook_deliveries
        WHERE endpoint_id = ? ORDER BY event_type`,
      )
        .bind(endpointId)
        .all<{
          eventType: string;
          entityType: string;
          entityId: string;
          idempotencyKey: string;
          payloadJson: string;
        }>();
      expect(
        deliveries.results.map(({ eventType, entityType, entityId }) => ({
          eventType,
          entityType,
          entityId,
        })),
      ).toEqual([
        {
          eventType: "submission.created",
          entityType: "submission",
          entityId: submissionId,
        },
        {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: submissionId,
        },
        {
          eventType: "submission.updated",
          entityType: "submission",
          entityId: submissionId,
        },
        {
          eventType: "submission.withdrawn",
          entityType: "submission",
          entityId: submissionId,
        },
      ]);
      expect(
        deliveries.results.map((delivery) => delivery.idempotencyKey),
      ).toEqual([
        `webhook:${endpointId}:submission.created:${submissionId}`,
        `webhook:${endpointId}:submission.submitted:${submissionId}`,
        `webhook:${endpointId}:submission.updated:${submissionId}:${revisedRow!.revision}`,
        `webhook:${endpointId}:submission.withdrawn:${submissionId}`,
      ]);
      expect(
        queuedMessages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "webhook.deliver",
        ),
      ).toHaveLength(4);
      expect(
        queuedMessages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "submission.notification",
        ),
      ).toHaveLength(1);
      expect(JSON.parse(deliveries.results[0]!.payloadJson).data).toMatchObject(
        {
          entityId: submissionId,
          status: "draft",
          anonymous: true,
        },
      );
      await expect(
        env.DB.prepare(
          `SELECT status FROM submissions WHERE id = ? AND event_id = 'evt-foe-2025'`,
        )
          .bind(submissionId)
          .first(),
      ).resolves.toEqual({ status: "withdrawn" });
    });
  });
});
