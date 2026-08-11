import { z } from "zod";
import { findSessionFormatConfiguration } from "~/modules/events/event-configuration";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ApplicantSessionService,
  requireApplicantPepper,
} from "./applicant-session.server";
import { SubmissionStateError } from "./submission-repository.server";
import {
  DEFAULT_FORM_SCHEMA,
  routingSchema,
  saveFormSchema,
  type SaveFormInput,
} from "./submission-schema";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";

export abstract class SubmissionFormWorkflows extends SubmissionServiceFoundation {
  async getAdminWorkspace(viewer: Viewer, formId?: string) {
    await this.airtable.assertReadable(viewer);
    return this.repository.getAdminWorkspace(
      viewer.organisationId,
      viewer.eventId,
      formId,
    );
  }

  async listAdminForms(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const forms = await this.env.DB.prepare(
      `SELECT form.id, form.name, form.kind, form.status,
              form.public_slug AS publicSlug,
              MAX(CASE WHEN version.status = 'published' THEN version.version_number END) AS publishedVersion
         FROM form_definitions form
         JOIN events event ON event.id = form.event_id AND event.organisation_id = ?
         LEFT JOIN form_versions version
           ON version.form_id = form.id AND version.event_id = form.event_id
        WHERE form.event_id = ? AND form.status <> 'archived'
        GROUP BY form.id
        ORDER BY form.updated_at DESC, form.name`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        name: string;
        kind: "submission" | "direct_session";
        status: string;
        publicSlug: string;
        publishedVersion: number | null;
      }>();
    return forms.results;
  }

  async getLatestPublishedFormSlug(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ) {
    await this.airtable.assertReadable(viewer);
    const form = await this.env.DB.prepare(
      `SELECT form.public_slug AS publicSlug
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
        WHERE form.event_id = ? AND form.status = 'published'
        ORDER BY form.updated_at DESC, form.id
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{ publicSlug: string }>();
    return form?.publicSlug ?? null;
  }

  defaultFormInput(
    accessMode: SaveFormInput["accessMode"],
    tracks: Array<{ id: string; name: string }>,
  ): SaveFormInput {
    const schema = structuredClone(DEFAULT_FORM_SCHEMA);
    const trackField = schema.fields.find((field) => field.id === "category")!;
    trackField.options = tracks.map((track) => track.name);
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
      schema,
      routing: {
        categories: {},
        trackIds: Object.fromEntries(
          tracks.map((track) => [track.name, track.id]),
        ),
        trackNames: Object.fromEntries(
          tracks.map((track) => [track.id, track.name]),
        ),
        teamNames: {},
        directSessionDurationMinutes: null,
        passwordHash: null,
      },
    };
  }

  async getDefaultFormInput(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const [event, tracks] = await Promise.all([
      this.env.DB.prepare(
        `SELECT submission_access_mode AS accessMode
           FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ accessMode: SaveFormInput["accessMode"] }>(),
      this.listRoutingTracks(viewer),
    ]);
    if (!event) throw new Response("Event not found", { status: 404 });
    return this.defaultFormInput(event.accessMode, tracks);
  }

  async saveForm(
    viewer: Viewer,
    rawInput: unknown,
    operation?: {
      operationId: string;
      formId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?
            AND form.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions version
               WHERE version.id = ? AND version.form_id = form.id
                 AND version.event_id = form.event_id
            )`,
      )
        .bind(
          viewer.organisationId,
          operation.formId,
          viewer.eventId,
          operation.operationId,
          operation.versionId,
        )
        .first<{ id: string }>();
      if (recovered) return recovered.id;
      return this.projectIntentCommand(
        viewer,
        "submission.form.save",
        operation.operationId,
        rawInput,
        () => this.saveFormD1(viewer, rawInput, operation),
      );
    }
    return this.projectCommand(viewer, "submission.form.save", rawInput, () =>
      this.saveFormD1(viewer, rawInput),
    );
  }

  protected async saveFormD1(
    viewer: Viewer,
    rawInput: unknown,
    operation?: {
      operationId: string;
      formId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    const input = saveFormSchema.parse(rawInput);
    const categoryField = input.schema.fields.find(
      (field) => field.id === "category",
    )!;
    const configuredTracks = await this.listRoutingTracks(viewer);
    const tracksByName = new Map<string, Array<{ id: string; name: string }>>();
    for (const track of configuredTracks) {
      tracksByName.set(track.name, [
        ...(tracksByName.get(track.name) ?? []),
        track,
      ]);
    }
    const selectedTracks = categoryField.options.map((name) => {
      const matches = tracksByName.get(name) ?? [];
      if (matches.length !== 1) {
        throw new SubmissionStateError(
          matches.length === 0
            ? `Track “${name}” is not configured for this event.`
            : `Track name “${name}” is ambiguous. Give every event track a unique name before using it in a form.`,
        );
      }
      return matches[0]!;
    });
    if (input.kind === "direct_session") {
      const { formats: configuredFormats } =
        await this.getConfiguredSessionFormatSnapshotD1(viewer);
      const formatField = input.schema.fields.find(
        (field) => field.id === "format",
      )!;
      let resolvedKeys: string[];
      try {
        resolvedKeys = formatField.options.map((option) => {
          const configured = findSessionFormatConfiguration(
            configuredFormats,
            option,
          );
          if (!configured) {
            throw new SubmissionStateError(
              `Direct-session format “${option}” is not configured for this event.`,
            );
          }
          return configured.key;
        });
      } catch (error) {
        if (error instanceof SubmissionStateError) throw error;
        throw new SubmissionStateError(
          error instanceof Error
            ? error.message
            : "The direct-session form has invalid format configuration.",
        );
      }
      if (new Set(resolvedKeys).size !== resolvedKeys.length) {
        throw new SubmissionStateError(
          "Direct-session format options must map to distinct event formats.",
        );
      }
    }
    let passwordHash: string | null = null;
    if (input.accessMode === "password_protected") {
      if (input.accessPassword) {
        passwordHash = await ApplicantSessionService.hashPassword(
          input.accessPassword,
          requireApplicantPepper(this.env),
        );
      } else if (input.id) {
        const existing = await this.repository.getAdminWorkspace(
          viewer.organisationId,
          viewer.eventId,
          input.id,
        );
        if (!existing) throw new Response("Form not found", { status: 404 });
        passwordHash = existing.draftVersion.routing.passwordHash;
        if (!passwordHash) {
          throw new SubmissionStateError(
            "Set an access password before saving this password-protected form.",
          );
        }
      }
    }
    const configuredTeamIds = [
      ...new Set(Object.values(input.routing.categories)),
    ];
    let teamNames: Record<string, string> = {};
    if (configuredTeamIds.length) {
      const placeholders = configuredTeamIds.map(() => "?").join(",");
      const teams = await this.env.DB.prepare(
        `SELECT team.id, team.name
           FROM evaluation_teams team
           JOIN events event
             ON event.id = team.event_id AND event.organisation_id = ?
          WHERE team.event_id = ? AND team.status = 'active'
            AND team.id IN (${placeholders})`,
      )
        .bind(viewer.organisationId, viewer.eventId, ...configuredTeamIds)
        .all<{ id: string; name: string }>();
      if (teams.results.length !== configuredTeamIds.length) {
        throw new SubmissionStateError(
          "Every track route must reference an active evaluation team in this event.",
        );
      }
      teamNames = Object.fromEntries(
        teams.results.map((team) => [team.id, team.name]),
      );
    }
    const routing = routingSchema.parse({
      ...input.routing,
      trackIds: Object.fromEntries(
        selectedTracks.map((track) => [track.name, track.id]),
      ),
      trackNames: Object.fromEntries(
        selectedTracks.map((track) => [track.id, track.name]),
      ),
      teamNames,
      passwordHash,
    });
    const saved = { ...input, routing };
    if (!input.id)
      return this.repository.createForm(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        saved,
        operation,
      );
    await this.repository.saveForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      input.id,
      saved,
      operation
        ? {
            operationId: operation.operationId,
            auditId: operation.auditId,
          }
        : undefined,
    );
    return input.id;
  }

  async publishForm(
    viewer: Viewer,
    formId: string,
    formRevision: unknown,
    draftRevision: unknown,
    operation?: {
      operationId: string;
      nextVersionId: string;
      auditId: string;
    },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?
            AND form.status = 'published' AND form.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions next_draft
               WHERE next_draft.id = ? AND next_draft.form_id = form.id
                 AND next_draft.event_id = form.event_id
                 AND next_draft.status = 'draft'
            )`,
      )
        .bind(
          viewer.organisationId,
          formId,
          viewer.eventId,
          operation.operationId,
          operation.nextVersionId,
        )
        .first();
      if (recovered) return;
      return this.projectIntentCommand(
        viewer,
        "submission.form.publish",
        operation.operationId,
        { formId, formRevision, draftRevision },
        () =>
          this.publishFormD1(
            viewer,
            formId,
            formRevision,
            draftRevision,
            operation,
          ),
      );
    }
    return this.projectCommand(
      viewer,
      "submission.form.publish",
      { formId, formRevision, draftRevision },
      () => this.publishFormD1(viewer, formId, formRevision, draftRevision),
    );
  }

  protected async publishFormD1(
    viewer: Viewer,
    formId: string,
    formRevision: unknown,
    draftRevision: unknown,
    operation?: {
      operationId: string;
      nextVersionId: string;
      auditId: string;
    },
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
    const trackField = workspace.draftVersion.schema.fields.find(
      (field) => field.id === "category",
    )!;
    if (trackField.options.length === 0) {
      throw new SubmissionStateError(
        "Configure at least one selectable event track before publishing this form.",
      );
    }
    const mappedTrackIds = trackField.options.map((trackName) => {
      const trackId = workspace.draftVersion.routing.trackIds[trackName];
      if (
        !trackId ||
        workspace.draftVersion.routing.trackNames[trackId] !== trackName
      ) {
        throw new SubmissionStateError(
          "The form's track identities are incomplete. Save the form again before publishing.",
        );
      }
      return trackId;
    });
    const currentTracks = await this.env.DB.prepare(
      `SELECT track.id, track.name
         FROM tracks track
         JOIN events event
           ON event.id = track.event_id AND event.organisation_id = ?
        WHERE track.event_id = ?
          AND track.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        JSON.stringify(mappedTrackIds),
      )
      .all<{ id: string; name: string }>();
    const currentTrackNames = new Map(
      currentTracks.results.map((track) => [track.id, track.name]),
    );
    if (
      currentTracks.results.length !== mappedTrackIds.length ||
      mappedTrackIds.some(
        (trackId) =>
          currentTrackNames.get(trackId) !==
          workspace.draftVersion.routing.trackNames[trackId],
      )
    ) {
      throw new SubmissionStateError(
        "An event track changed after this form draft was saved. Save the form again before publishing.",
      );
    }
    let expectedSessionFormatsJson: string | null = null;
    if (workspace.kind === "direct_session") {
      const formatSnapshot =
        await this.getConfiguredSessionFormatSnapshotD1(viewer);
      const formatField = workspace.draftVersion.schema.fields.find(
        (field) => field.id === "format",
      )!;
      const resolvedKeys = formatField.options.map((option) => {
        const configured = findSessionFormatConfiguration(
          formatSnapshot.formats,
          option,
        );
        if (!configured) {
          throw new SubmissionStateError(
            `Direct-session format “${option}” is not configured for this event.`,
          );
        }
        return configured.key;
      });
      if (new Set(resolvedKeys).size !== resolvedKeys.length) {
        throw new SubmissionStateError(
          "Direct-session format options must map to distinct event formats.",
        );
      }
      expectedSessionFormatsJson = formatSnapshot.serialized;
    }
    const configuredTeamIds = [
      ...new Set(Object.values(workspace.draftVersion.routing.categories)),
    ];
    if (configuredTeamIds.length) {
      const placeholders = configuredTeamIds.map(() => "?").join(",");
      const teams = await this.env.DB.prepare(
        `SELECT id, name FROM evaluation_teams
          WHERE event_id = ? AND status = 'active' AND id IN (${placeholders})`,
      )
        .bind(viewer.eventId, ...configuredTeamIds)
        .all<{ id: string; name: string }>();
      if (teams.results.length !== configuredTeamIds.length) {
        throw new SubmissionStateError(
          "Every track route must reference an active evaluation team in this event.",
        );
      }
      const names = new Map(teams.results.map((team) => [team.id, team.name]));
      for (const teamId of configuredTeamIds) {
        if (
          workspace.draftVersion.routing.teamNames[teamId] !== names.get(teamId)
        ) {
          throw new SubmissionStateError(
            "A routed evaluation team changed after this form draft was saved. Save the form again before publishing.",
          );
        }
      }
    }
    await this.repository.publishForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      formId,
      parsedFormRevision,
      parsedDraftRevision,
      operation,
      expectedSessionFormatsJson,
    );
  }

  async listRoutingTeams(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const teams = await this.env.DB.prepare(
      `SELECT team.id, team.name
         FROM evaluation_teams team
         JOIN events event ON event.id = team.event_id AND event.organisation_id = ?
        WHERE team.event_id = ? AND team.status = 'active'
        ORDER BY team.name, team.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{ id: string; name: string }>();
    return teams.results;
  }

  async listRoutingTracks(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const tracks = await this.env.DB.prepare(
      `SELECT track.id, track.name
         FROM tracks track
         JOIN events event ON event.id = track.event_id AND event.organisation_id = ?
        WHERE track.event_id = ?
        ORDER BY track.position, track.name, track.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{ id: string; name: string }>();
    return tracks.results;
  }

  async getPublicForm(publicSlug: string) {
    const form = await this.getPublicFormD1(publicSlug);
    const freshness = await this.airtable.assertReadable(
      await this.publicScope(form.eventId),
    );
    // Airtable-backed reads refresh the D1 projection. Read the form again so
    // this request cannot return the pre-refresh version that was used only to
    // discover the public form's event scope.
    return freshness === null ? form : this.getPublicFormD1(publicSlug);
  }

  protected async getPublicFormD1(publicSlug: string) {
    const form = await this.repository.getPublicForm(publicSlug);
    if (!form)
      throw new Response("Application form not found", { status: 404 });
    return form;
  }
}
