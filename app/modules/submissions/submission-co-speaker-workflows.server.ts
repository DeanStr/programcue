import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  hashApplicantToken,
  type PublicForm,
} from "./applicant-session.server";
import {
  buildCoSpeakerInvitationPlan,
  persistQueueFailure,
} from "./co-speaker-invitation.server";
import {
  type Applicant,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "./submission-repository-shared";
import { draftPayloadSchema } from "./submission-schema";
import {
  SubmissionCommittedStateError,
  SubmissionServiceFoundation,
} from "./submission-service-foundation.server";

export class SubmissionCoSpeakerWorkflows extends SubmissionServiceFoundation {
  async updateClaimedSpeakerProfile(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before updating a speaker profile.",
      );
    }
    const form = await this.getPublicForm(publicSlug);
    return this.updateClaimedSpeakerProfileForForm(
      publicSlug,
      form,
      applicant,
      rawInput,
    );
  }

  async updateClaimedCoSpeakerProfile(
    publicSlug: string,
    speakerId: string,
    request: Request,
    rawInput: unknown,
  ) {
    const { form, applicant } = await this.requireClaimedCoSpeakerContext(
      publicSlug,
      speakerId,
      request,
    );
    return this.updateClaimedSpeakerProfileForForm(
      publicSlug,
      form,
      applicant,
      rawInput,
    );
  }

  protected async updateClaimedSpeakerProfileForForm(
    publicSlug: string,
    form: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
  ) {
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.speaker_profile.update",
      { publicSlug, rawInput },
      () => this.updateClaimedSpeakerProfileD1(form, applicant, rawInput),
    );
  }

  protected async updateClaimedSpeakerProfileD1(
    form: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        revision: z.coerce.number().int().positive(),
        name: z.string().trim().min(1).max(120),
        biography: z.string().trim().max(5_000),
      })
      .parse(rawInput);
    const operationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE people
            SET display_name = ?, biography = ?, profile_revision = profile_revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND profile_revision = ? AND email_verified = 1
            AND EXISTS (
              SELECT 1 FROM submission_speakers speaker
              JOIN submissions submission
                ON submission.id = speaker.submission_id
               AND submission.event_id = speaker.event_id
              JOIN form_versions version
                ON version.id = submission.form_version_id
               AND version.event_id = submission.event_id
             WHERE speaker.person_id = people.id
               AND speaker.invitation_status = 'claimed'
               AND version.form_id = ? AND speaker.event_id = ?
            )`,
      ).bind(
        input.name,
        input.biography || null,
        operationId,
        applicant.personId,
        input.revision,
        form.id,
        form.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE submission_speakers
            SET display_name = ?, updated_at = unixepoch()
          WHERE person_id = ? AND event_id = ? AND invitation_status = 'claimed'
            AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        input.name,
        applicant.personId,
        form.eventId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         ) SELECT ?, 'person', 'public_form', 1, event.organisation_id, ?, ?, 'speaker.profile.updated',
                  'person', ?, ?, unixepoch()
             FROM events event
            WHERE event.id = ?
              AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        applicant.personId,
        applicant.personId,
        JSON.stringify({ source: "application_claim" }),
        form.eventId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM people
             WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
          )
         RETURNING sequence`,
      ).bind(
        form.eventId,
        applicant.personId,
        operationId,
        applicant.personId,
        input.revision + 1,
        operationId,
      ),
    ]);
    const [updated] = results;
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionRevisionConflictError();
    }
    if (!results[3]?.results[0]) {
      throw new Error(
        "The committed speaker profile change cursor was not recorded.",
      );
    }
  }

  async claimCoSpeaker(
    publicSlug: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    await this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.co_speaker.claim",
      { publicSlug, invitationId, applicant },
      () => this.repository.claimCoSpeaker(form.id, applicant, invitationId),
    );
  }

  async getCoSpeakerClaim(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form) return null;
    return this.getCoSpeakerClaimD1(form, speakerId, rawToken);
  }

  async claimCoSpeakerToken(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.requireCoSpeakerClaimForm(
      publicSlug,
      speakerId,
      rawToken,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: null },
      "submission.co_speaker_token.claim",
      { publicSlug, speakerId, rawToken },
      () => this.claimCoSpeakerTokenD1(form, speakerId, rawToken),
      { replay: "reject" },
    );
  }

  protected async claimCoSpeakerTokenD1(
    form: PublicForm,
    speakerId: string,
    rawToken: string,
  ) {
    const expectedClaimTokenHash = await hashApplicantToken(
      `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
    );
    const claim = await this.getCoSpeakerClaimD1(form, speakerId, rawToken);
    if (!claim) {
      throw new SubmissionStateError(
        "This co-speaker claim link is invalid or has been replaced.",
      );
    }
    if (claim.expired) {
      await this.env.DB.prepare(
        `UPDATE submission_speakers
            SET invitation_status = 'expired', updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND invitation_status IN ('pending','sent')
            AND invitation_expires_at <= unixepoch()`,
      )
        .bind(speakerId, form.eventId)
        .run();
      throw new SubmissionCommittedStateError(
        "This co-speaker claim link has expired. Ask an administrator to resend it.",
      );
    }
    const proposedBiography = await this.env.DB.prepare(
      `SELECT revision.speaker_snapshot_json AS speakerSnapshotJson
         FROM submission_revisions revision
        WHERE revision.submission_id = ? AND revision.event_id = ?
        ORDER BY revision.revision_number DESC LIMIT 1`,
    )
      .bind(claim.submissionId, form.eventId)
      .first<{ speakerSnapshotJson: string }>();
    if (!proposedBiography) {
      throw new SubmissionStateError(
        "The latest submission speaker revision is unavailable for this co-speaker claim.",
      );
    }
    const speakers = draftPayloadSchema.shape.speakers.parse(
      JSON.parse(proposedBiography.speakerSnapshotJson),
    );
    const matchingSpeaker = speakers.find(
      (speaker) => speaker.email.toLowerCase() === claim.email.toLowerCase(),
    );
    if (!matchingSpeaker) {
      throw new SubmissionStateError(
        "The latest submission speaker revision does not contain this co-speaker claim.",
      );
    }
    const biography = matchingSpeaker.biography;
    const personId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(personId, claim.email, claim.displayName, biography ?? null),
    ]);
    const person = await this.env.DB.prepare(
      `SELECT id AS personId, email, display_name AS name,
              COALESCE(biography, '') AS biography,
              profile_revision AS profileRevision
         FROM people WHERE email = ? COLLATE NOCASE`,
    )
      .bind(claim.email)
      .first<{
        personId: string;
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
      }>();
    if (!person) {
      throw new SubmissionStateError(
        "The co-speaker identity could not be established.",
      );
    }
    const preparedSession = await this.applicants.prepareVerifiedSession(
      form,
      person.personId,
    );
    if (!preparedSession.applicant.verified) {
      throw new Error("A prepared co-speaker claim session must be verified.");
    }
    await this.repository.claimCoSpeaker(
      form.id,
      preparedSession.applicant,
      speakerId,
      expectedClaimTokenHash,
      preparedSession.persistence,
      biography ?? null,
    );
    const claimedApplicant = {
      ...preparedSession.applicant,
      biography:
        preparedSession.applicant.biography.trim() || biography?.trim() || "",
    };
    return {
      applicant:
        form.accessMode === "account_required"
          ? { ...claimedApplicant, claimOnly: true }
          : claimedApplicant,
      cookie: preparedSession.cookie,
      setCookies: preparedSession.setCookies,
    };
  }

  async resendCoSpeakerInvitation(viewer: Viewer, invitationId: string) {
    return this.projectCommand(
      viewer,
      "submission.co_speaker.resend",
      { invitationId },
      () => this.resendCoSpeakerInvitationD1(viewer, invitationId),
    );
  }

  protected async resendCoSpeakerInvitationD1(
    viewer: Viewer,
    invitationId: string,
  ) {
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const row = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.email, speaker.display_name AS displayName,
              speaker.claim_token_hash AS claimTokenHash,
              submission.id AS submissionId, submission.title AS submissionTitle,
              form.id AS formId, form.public_slug AS publicSlug,
              event.name AS eventName, event.starts_at AS startsAt,
              event.ends_at AS endsAt, event.brand_accent AS brandAccent,
              event.venue_name AS venueName,
              event.city
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
         JOIN events event
           ON event.id = speaker.event_id AND event.organisation_id = ?
        WHERE speaker.id = ? AND speaker.event_id = ? AND speaker.is_primary = 0
          AND speaker.invitation_status IN ('pending','sent','expired')`,
    )
      .bind(viewer.organisationId, invitationId, viewer.eventId)
      .first<{
        id: string;
        email: string;
        displayName: string;
        claimTokenHash: string | null;
        submissionId: string;
        submissionTitle: string;
        formId: string;
        publicSlug: string;
        eventName: string;
        brandAccent: string;
        startsAt: number;
        endsAt: number;
        venueName: string | null;
        city: string | null;
      }>();
    if (!row) {
      throw new SubmissionStateError(
        "This co-speaker invitation is unavailable in the current event.",
      );
    }
    const plan = await buildCoSpeakerInvitationPlan(
      this.env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        eventName: row.eventName,
        brandAccent: row.brandAccent,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        physicalAddress: [row.venueName, row.city]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(", "),
        formId: row.formId,
        publicSlug: row.publicSlug,
        submissionId: row.submissionId,
        submissionTitle: row.submissionTitle,
        requestedByPersonId: viewer.personId,
      },
      row,
    );
    const [updated] = await this.env.DB.batch(plan.statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionStateError(
        "This invitation changed before it could be resent. Refresh and try again.",
      );
    }
    try {
      await operationsQueue.send(plan.message);
      return { status: "queued" as const, operationId: plan.operationId };
    } catch (error) {
      await persistQueueFailure(this.env, plan, error);
      return { status: "queue_failed" as const, operationId: plan.operationId };
    }
  }
}
