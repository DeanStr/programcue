import { z } from "zod";

import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ApplicantSessionService,
  requireApplicantPepper,
  type PublicForm,
} from "./applicant-session.server";
import {
  D1SubmissionRepository,
  SubmissionStateError,
  type Applicant,
  type FormWorkspace,
} from "./submission-repository.server";
import {
  DEFAULT_FORM_SCHEMA,
  draftPayloadSchema,
  routingSchema,
  saveFormSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleAnswers,
  type SaveFormInput,
} from "./submission-schema";

export class PublicFormUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFormUnavailableError";
  }
}

const directSessionSchema = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(3_000).default(""),
  format: z.enum([
    "keynote",
    "presentation",
    "panel",
    "workshop",
    "breakout",
    "other",
  ]),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  speakerName: z.string().trim().min(1).max(120),
  speakerEmail: z.string().trim().toLowerCase().email().max(254),
});

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "session"
  );
}

function applicantFormView(form: PublicForm) {
  const { accessPasswordHash: _accessPasswordHash, version, ...summary } = form;
  const { routing: _routing, ...publicVersion } = version;
  return { ...summary, version: publicVersion };
}

function answerValidationError(errors: Record<string, string[]>) {
  return new z.ZodError(
    Object.entries(errors).flatMap(([path, messages]) =>
      messages.map((message) => ({
        code: "custom" as const,
        path: [path],
        message,
        input: undefined,
      })),
    ),
  );
}

export class SubmissionService {
  readonly repository: D1SubmissionRepository;
  readonly applicants: ApplicantSessionService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.repository = new D1SubmissionRepository(env);
    this.applicants = new ApplicantSessionService(env);
  }

  getAdminWorkspace(viewer: Viewer, formId?: string) {
    return this.repository.getAdminWorkspace(
      viewer.organisationId,
      viewer.eventId,
      formId,
    );
  }

  defaultFormInput(accessMode: SaveFormInput["accessMode"]): SaveFormInput {
    return {
      name: "Call for Speakers",
      kind: "submission",
      publicSlug: "call-for-speakers",
      closeDate: null,
      submissionLimit: null,
      minSpeakers: 1,
      maxSpeakers: 4,
      accessMode,
      accessPassword: "",
      schema: DEFAULT_FORM_SCHEMA,
      routing: {
        categories: {
          "AI & Innovation": "Innovation committee",
          "Event Operations": "Programme committee",
          "Experience Design": "Experience committee",
        },
        passwordHash: null,
      },
    };
  }

  async getDefaultFormInput(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT submission_access_mode AS accessMode
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ accessMode: SaveFormInput["accessMode"] }>();
    if (!event) throw new Response("Event not found", { status: 404 });
    return this.defaultFormInput(event.accessMode);
  }

  async saveForm(viewer: Viewer, rawInput: unknown) {
    const input = saveFormSchema.parse(rawInput);
    const routing = routingSchema.parse({
      ...input.routing,
      passwordHash:
        input.accessMode !== "password_protected"
          ? null
          : input.accessPassword
            ? await ApplicantSessionService.hashPassword(
                input.accessPassword,
                requireApplicantPepper(this.env),
              )
            : input.routing.passwordHash,
    });
    const saved = { ...input, routing };
    if (!input.id)
      return this.repository.createForm(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        saved,
      );
    await this.repository.saveForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      input.id,
      saved,
    );
    return input.id;
  }

  async publishForm(
    viewer: Viewer,
    formId: string,
    formRevision: unknown,
    draftRevision: unknown,
  ) {
    const parsedFormRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(formRevision);
    const parsedDraftRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(draftRevision);
    const workspace = await this.repository.getAdminWorkspace(
      viewer.organisationId,
      viewer.eventId,
      formId,
    );
    if (!workspace) throw new Response("Form not found", { status: 404 });
    if (
      workspace.accessMode === "password_protected" &&
      !workspace.draftVersion.routing.passwordHash
    ) {
      throw new SubmissionStateError(
        "Set and save an access password before publishing this form.",
      );
    }
    await this.repository.publishForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      formId,
      parsedFormRevision,
      parsedDraftRevision,
    );
  }

  async getPublicForm(publicSlug: string) {
    const form = await this.repository.getPublicForm(publicSlug);
    if (!form)
      throw new Response("Application form not found", { status: 404 });
    return form;
  }

  private applicationAvailability(
    form: Awaited<ReturnType<SubmissionService["getPublicForm"]>>,
  ) {
    if (
      form.closesAt !== null &&
      form.closesAt < Math.floor(Date.now() / 1_000)
    ) {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    if (
      form.submissionLimit !== null &&
      form.submittedCount >= form.submissionLimit
    ) {
      return {
        accepting: false as const,
        reason: "This call for speakers has reached its submission limit.",
      };
    }
    return { accepting: true as const, reason: null };
  }

  async getApplicantPortal(
    publicSlug: string,
    request: Request,
    selectedId?: string | null,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const applicant = await this.applicants.get(request, form);
    const availability = this.applicationAvailability(form);
    if (!applicant) {
      const browserForm = applicantFormView(form);
      return {
        form: browserForm,
        applicant: null,
        drafts: [],
        invitations: [],
        selected: null,
        selectedForm: browserForm,
        availability,
      };
    }
    const [drafts, invitations] = await Promise.all([
      this.repository.getApplicantDrafts(form.id, applicant),
      this.repository.getCoSpeakerInvitations(form.id, applicant),
    ]);
    const requestedDraft = selectedId !== null && selectedId !== undefined;
    const selected = requestedDraft
      ? (drafts.find((draft) => draft.id === selectedId) ?? null)
      : (drafts.find((draft) => draft.status === "draft") ??
        drafts.at(0) ??
        null);
    if (requestedDraft && !selected) {
      throw new Response("Application draft not found", { status: 404 });
    }
    const selectedForm = selected
      ? await this.repository.getApplicantDraftForm(
          form,
          applicant,
          selected.id,
        )
      : form;
    return {
      form: applicantFormView(form),
      applicant,
      drafts,
      invitations,
      selected,
      selectedForm: applicantFormView(selectedForm),
      availability,
    };
  }

  async createDraft(publicSlug: string, applicant: Applicant) {
    const form = await this.getPublicForm(publicSlug);
    const availability = this.applicationAvailability(form);
    if (!availability.accepting)
      throw new PublicFormUnavailableError(availability.reason);
    return this.repository.createDraft(form, applicant);
  }

  async saveDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    const currentForm = await this.getPublicForm(publicSlug);
    const payload = draftPayloadSchema.parse(rawPayload);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const errors = validateAnswerShapes(form.version.schema, payload.answers);
    if (Object.keys(errors).length) throw answerValidationError(errors);
    return this.repository.saveDraft(form, applicant, payload);
  }

  async submitDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    const currentForm = await this.getPublicForm(publicSlug);
    const availability = this.applicationAvailability(currentForm);
    if (!availability.accepting)
      throw new PublicFormUnavailableError(availability.reason);
    const payload = draftPayloadSchema.parse(rawPayload);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const shapeErrors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
    );
    if (Object.keys(shapeErrors).length)
      throw answerValidationError(shapeErrors);
    const submittedPayload = {
      ...payload,
      answers: visibleAnswers(form.version.schema, payload.answers),
    };
    const errors = validateFinalAnswers(
      form.version.schema,
      submittedPayload.answers,
      submittedPayload.speakers,
      form.minSpeakers,
      form.maxSpeakers,
    );
    if (Object.keys(errors).length) {
      throw answerValidationError(errors);
    }
    return this.repository.submitDraft(form, applicant, submittedPayload);
  }

  async claimCoSpeaker(
    publicSlug: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    await this.repository.claimCoSpeaker(form.id, applicant, invitationId);
  }

  listAdminSubmissions(
    viewer: Viewer,
    filters: { status?: string; category?: string; query?: string },
  ) {
    return this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
    );
  }

  getAdminSubmission(viewer: Viewer, submissionId: string) {
    return this.repository.getAdminSubmission(
      viewer.organisationId,
      viewer.eventId,
      submissionId,
    );
  }

  async createDirectSession(viewer: Viewer, rawInput: unknown) {
    const input = directSessionSchema.parse(rawInput);
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found", { status: 404 });
    const sessionId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const slug = `${slugify(input.title)}-${sessionId.slice(0, 6)}`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO people (id, email, display_name, email_verified, profile_status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
        ON CONFLICT(email) DO NOTHING
      `,
      ).bind(personId, input.speakerEmail, input.speakerName),
      this.env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, description, format, duration_minutes, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unscheduled', unixepoch(), unixepoch())
      `,
      ).bind(
        sessionId,
        viewer.eventId,
        input.title,
        slug,
        input.description || null,
        input.format,
        input.durationMinutes,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO session_speakers (session_id, event_id, person_id, position, role_label)
        SELECT ?, ?, id, 0, 'Speaker' FROM people WHERE email = ? COLLATE NOCASE
      `,
      ).bind(sessionId, viewer.eventId, input.speakerEmail),
      ...materializePublishedResourceAcknowledgementsForSession(
        this.env,
        viewer.eventId,
        sessionId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, 'session.direct.created', 'session', ?, ?, unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        sessionId,
        JSON.stringify({
          title: input.title,
          speakerEmail: input.speakerEmail,
        }),
      ),
    ]);
    return sessionId;
  }

  static workspaceToInput(workspace: FormWorkspace): SaveFormInput {
    return {
      id: workspace.id,
      revision: workspace.revision,
      draftRevision: workspace.draftVersion.revision,
      name: workspace.name,
      kind: workspace.kind,
      publicSlug: workspace.publicSlug,
      closeDate: D1SubmissionRepository.closeDateFromEpoch(
        workspace.closesAt,
        workspace.eventTimezone,
      ),
      submissionLimit: workspace.submissionLimit,
      minSpeakers: workspace.minSpeakers,
      maxSpeakers: workspace.maxSpeakers,
      accessMode: workspace.accessMode,
      accessPassword: "",
      schema: workspace.draftVersion.schema,
      routing: workspace.draftVersion.routing,
    };
  }
}
