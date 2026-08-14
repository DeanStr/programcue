import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

export const aiProviderKeys = ["workers_ai", "openai", "anthropic"] as const;
export type AiProviderKey = (typeof aiProviderKeys)[number];

export const aiProviderLabels = {
  workers_ai: "Workers AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
} as const satisfies Record<AiProviderKey, string>;

const settingsInputSchema = z
  .object({
    provider: z.enum(aiProviderKeys),
    model: z.string().trim().min(1).max(100),
    revision: z.coerce.number().int().min(0),
  })
  .strict();

const endpointSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Provider endpoints must use HTTPS.",
});

export type AiProviderSelection = {
  provider: AiProviderKey;
  model: string;
  revision: number;
};

export type AiProviderReadiness = {
  configured: boolean;
  missing: string[];
  problem: string | null;
  selection: AiProviderSelection | null;
  providerLabel: string | null;
  model: string | null;
};

export class AiProviderSettingsConflictError extends Error {
  constructor() {
    super(
      "AI provider settings changed in another session. Reload before saving.",
    );
    this.name = "AiProviderSettingsConflictError";
  }
}

function assertOrganisationOwner(viewer: Viewer) {
  if (viewer.role !== "owner") {
    throw new Response(
      "Only an organisation owner can change the AI provider.",
      { status: 403 },
    );
  }
}

function configurationProblem(
  env: CloudflareEnvironment,
  selection: AiProviderSelection,
) {
  // `missing` names the exact deployment variable for logs and support; the
  // reader of `problem` chose the provider and model in this product but cannot
  // set its credentials, so `problem` says what is wrong and who can fix it.
  const providerLabel = aiProviderLabels[selection.provider];
  const credentialsUnavailable = `${providerLabel} credentials are not configured for this installation. Ask whoever deploys Program Cue to add them, or select a different provider.`;

  if (selection.provider === "workers_ai") {
    if (!env.AI)
      return {
        missing: ["AI Workers binding"],
        problem: credentialsUnavailable,
      };
    if (!/^@cf\/openai\/gpt-oss-(?:20b|120b)$/u.test(selection.model)) {
      return {
        missing: [],
        problem:
          "Workers AI currently requires the model @cf/openai/gpt-oss-20b or @cf/openai/gpt-oss-120b. Choose one of those models for this organisation.",
      };
    }
    return { missing: [], problem: null };
  }

  const keyName =
    selection.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const key =
    selection.provider === "openai"
      ? env.OPENAI_API_KEY?.trim()
      : env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { missing: [keyName], problem: credentialsUnavailable };
  if (key.length < 20)
    return { missing: [keyName], problem: credentialsUnavailable };
  const endpointName =
    selection.provider === "openai"
      ? "OPENAI_RESPONSES_URL"
      : "ANTHROPIC_MESSAGES_URL";
  const endpoint =
    selection.provider === "openai"
      ? env.OPENAI_RESPONSES_URL?.trim()
      : env.ANTHROPIC_MESSAGES_URL?.trim();
  if (endpoint && !endpointSchema.safeParse(endpoint).success) {
    return {
      missing: [endpointName],
      problem: `The ${providerLabel} endpoint configured for this installation is not a valid HTTPS address. Ask whoever deploys Program Cue to correct it.`,
    };
  }
  return { missing: [], problem: null };
}

export class AiProviderSettingsService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getSelection(
    organisationId: string,
  ): Promise<AiProviderSelection | null> {
    const row = await this.env.DB.prepare(
      `SELECT settings.provider, settings.model, settings.revision
         FROM organisation_ai_settings settings
         JOIN organisations organisation ON organisation.id = settings.organisation_id
        WHERE settings.organisation_id = ?`,
    )
      .bind(organisationId)
      .first<{ provider: string; model: string; revision: number }>();
    if (!row) return null;
    return {
      provider: z.enum(aiProviderKeys).parse(row.provider),
      model: z.string().trim().min(1).max(100).parse(row.model),
      revision: z.number().int().positive().parse(row.revision),
    };
  }

  async readiness(viewer: Viewer): Promise<AiProviderReadiness> {
    const selection = await this.getSelection(viewer.organisationId);
    if (!selection) {
      return {
        configured: false,
        missing: ["organisation AI provider selection"],
        problem:
          "Select an AI provider and explicit model for this organisation.",
        selection: null,
        providerLabel: null,
        model: null,
      };
    }
    const issue = configurationProblem(this.env, selection);
    return {
      configured: issue.problem === null,
      ...issue,
      selection,
      providerLabel: aiProviderLabels[selection.provider],
      model: selection.model,
    };
  }

  async save(viewer: Viewer, raw: unknown) {
    assertOrganisationOwner(viewer);
    const input = settingsInputSchema.parse(raw);
    const operationId = `assistant-provider-settings:${crypto.randomUUID()}`;
    const nextRevision = input.revision + 1;
    const mutation =
      input.revision === 0
        ? this.env.DB.prepare(
            `INSERT INTO organisation_ai_settings (
               organisation_id, provider, model, revision,
               last_updated_by_person_id, last_operation_id,
               created_at, updated_at
             ) SELECT ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
               )
                 AND EXISTS (SELECT 1 FROM people WHERE id = ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM organisation_ai_settings
                    WHERE organisation_id = ?
                 )`,
          ).bind(
            viewer.organisationId,
            input.provider,
            input.model,
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            viewer.personId,
            viewer.organisationId,
          )
        : this.env.DB.prepare(
            `UPDATE organisation_ai_settings
                SET provider = ?, model = ?, revision = revision + 1,
                    last_updated_by_person_id = ?, last_operation_id = ?,
                    updated_at = unixepoch()
              WHERE organisation_id = ? AND revision = ?
                AND EXISTS (
                  SELECT 1 FROM events
                   WHERE id = ? AND organisation_id = ?
                )
                AND EXISTS (SELECT 1 FROM people WHERE id = ?)`,
          ).bind(
            input.provider,
            input.model,
            viewer.personId,
            operationId,
            viewer.organisationId,
            input.revision,
            viewer.eventId,
            viewer.organisationId,
            viewer.personId,
          );
    const metadata = JSON.stringify({
      provider: input.provider,
      model: input.model,
      revision: nextRevision,
    });
    const [updated, audited] = await this.env.DB.batch([
      mutation,
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, settings.organisation_id, ?, ?,
                'assistant.provider.updated', 'organisation_ai_settings',
                settings.organisation_id, ?, ?, unixepoch()
           FROM organisation_ai_settings settings
          WHERE settings.organisation_id = ?
            AND settings.provider = ? AND settings.model = ?
            AND settings.revision = ? AND settings.last_operation_id = ?`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        metadata,
        viewer.organisationId,
        input.provider,
        input.model,
        nextRevision,
        operationId,
      ),
    ]);
    if (
      (updated.meta.changes ?? 0) !== 1 ||
      (audited.meta.changes ?? 0) !== 1
    ) {
      throw new AiProviderSettingsConflictError();
    }
    return {
      provider: input.provider,
      model: input.model,
      revision: nextRevision,
    } satisfies AiProviderSelection;
  }
}
