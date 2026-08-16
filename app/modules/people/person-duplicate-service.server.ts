import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

const organisationPersonSearchSchema = z
  .string()
  .trim()
  .min(2, "Enter at least two characters to search for a person.")
  .max(254, "Search terms cannot exceed 254 characters.")
  .superRefine((value, context) => {
    if (value.length <= 120 || z.string().email().safeParse(value).success)
      return;
    context.addIssue({
      code: "custom",
      message:
        "Search terms longer than 120 characters must be a complete email address.",
    });
  });

const duplicateCandidateSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().toLowerCase().email().max(254),
    }),
  )
  .min(1)
  .max(21);

export type DuplicatePersonMatch = {
  personId: string;
  name: string;
  email: string;
  reasons: Array<"same_email" | "same_name">;
  currentEvent: boolean;
  scopes: string[];
};

export type DuplicatePersonCheck = {
  enabled: boolean;
  matches: DuplicatePersonMatch[];
  truncated: boolean;
};

export type OrganisationPersonMatch = {
  personId: string;
  name: string;
  email: string;
  currentEventSpeakerStatus:
    | "prospect"
    | "invited"
    | "confirmed"
    | "declined"
    | "withdrawn"
    | null;
};

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function normalisedName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

type PersonRow = {
  personId: string;
  name: string;
  email: string;
  currentEvent: number;
  scopeNames: string | null;
};

export class PersonDuplicateService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async searchOrganisationPeople(
    viewer: Viewer,
    rawQuery: unknown,
  ): Promise<OrganisationPersonMatch[]> {
    const query = organisationPersonSearchSchema.parse(rawQuery);
    const exactEmailSearch = query.length > 120;
    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = await this.env.DB.prepare(
      `WITH organisation_people(person_id) AS (
         SELECT membership.person_id
           FROM memberships membership
          WHERE membership.organisation_id = ?
         UNION
         SELECT submission.submitter_person_id
           FROM submissions submission
           JOIN events event ON event.id = submission.event_id
          WHERE event.organisation_id = ?
            AND submission.submitter_person_id IS NOT NULL
         UNION
         SELECT speaker.person_id
           FROM submission_speakers speaker
           JOIN events event ON event.id = speaker.event_id
          WHERE event.organisation_id = ? AND speaker.person_id IS NOT NULL
         UNION
         SELECT session_speaker.person_id
           FROM session_speakers session_speaker
           JOIN events event ON event.id = session_speaker.event_id
          WHERE event.organisation_id = ?
         UNION
         SELECT workflow.person_id
           FROM event_speaker_workflows workflow
           JOIN events event ON event.id = workflow.event_id
          WHERE event.organisation_id = ?
       )
       SELECT person.id AS personId, person.display_name AS name, person.email,
              current_workflow.status AS currentEventSpeakerStatus
         FROM organisation_people scoped
         JOIN people person ON person.id = scoped.person_id
         LEFT JOIN event_speaker_workflows current_workflow
           ON current_workflow.event_id = ?
          AND current_workflow.person_id = person.id
        WHERE ${
          exactEmailSearch
            ? "lower(person.email) = lower(?)"
            : "(person.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR person.email LIKE ? ESCAPE '\\' COLLATE NOCASE)"
        }
        GROUP BY person.id, person.display_name, person.email,
                 current_workflow.status
        ORDER BY CASE
                   WHEN current_workflow.status IN ('prospect','invited','confirmed') THEN 0
                   WHEN current_workflow.status IS NOT NULL THEN 1
                   ELSE 2
                 END,
                 person.display_name COLLATE NOCASE, person.id
        LIMIT 10`,
    )
      .bind(
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.eventId,
        ...(exactEmailSearch ? [query] : [pattern, pattern]),
      )
      .all<OrganisationPersonMatch>();
    return rows.results;
  }

  async findLikelyDuplicates(
    viewer: Viewer,
    rawCandidates: unknown,
  ): Promise<DuplicatePersonCheck> {
    const candidates = duplicateCandidateSchema.parse(rawCandidates);
    const event = await this.env.DB.prepare(
      `SELECT duplicate_person_warnings AS duplicatePersonWarnings
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ duplicatePersonWarnings: number }>();
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
    if (!event.duplicatePersonWarnings) {
      return { enabled: false, matches: [], truncated: false };
    }

    const emails = [...new Set(candidates.map((candidate) => candidate.email))];
    const names = [
      ...new Set(candidates.map((candidate) => normalisedName(candidate.name))),
    ];
    const rows = await this.env.DB.prepare(
      `WITH organisation_people(person_id, event_id) AS (
         SELECT membership.person_id, membership.event_id
           FROM memberships membership
          WHERE membership.organisation_id = ?
         UNION
         SELECT submission.submitter_person_id, submission.event_id
           FROM submissions submission
           JOIN events submission_event ON submission_event.id = submission.event_id
          WHERE submission_event.organisation_id = ?
            AND submission.submitter_person_id IS NOT NULL
         UNION
         SELECT speaker.person_id, speaker.event_id
           FROM submission_speakers speaker
           JOIN events speaker_event ON speaker_event.id = speaker.event_id
          WHERE speaker_event.organisation_id = ? AND speaker.person_id IS NOT NULL
         UNION
         SELECT session_speaker.person_id, session_speaker.event_id
           FROM session_speakers session_speaker
           JOIN events session_event ON session_event.id = session_speaker.event_id
          WHERE session_event.organisation_id = ?
       )
       SELECT person.id AS personId, person.display_name AS name,
              person.email,
              MAX(CASE WHEN scoped.event_id = ? THEN 1 ELSE 0 END) AS currentEvent,
              group_concat(DISTINCT COALESCE(scoped_event.name, 'Organisation access')) AS scopeNames
         FROM organisation_people scoped
         JOIN people person ON person.id = scoped.person_id
         LEFT JOIN events scoped_event ON scoped_event.id = scoped.event_id
        WHERE lower(person.email) IN (${placeholders(emails)})
           OR lower(trim(replace(replace(replace(person.display_name, '  ', ' '), '  ', ' '), '  ', ' ')))
              IN (${placeholders(names)})
        GROUP BY person.id, person.display_name, person.email
        ORDER BY currentEvent DESC, person.display_name COLLATE NOCASE, person.id
        LIMIT 21`,
    )
      .bind(
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.eventId,
        ...emails,
        ...names,
      )
      .all<PersonRow>();

    const matches = rows.results.slice(0, 20).map((row) => {
      const reasons = new Set<DuplicatePersonMatch["reasons"][number]>();
      const rowEmail = row.email.toLocaleLowerCase();
      const rowName = normalisedName(row.name);
      for (const candidate of candidates) {
        if (candidate.email === rowEmail) reasons.add("same_email");
        if (normalisedName(candidate.name) === rowName)
          reasons.add("same_name");
      }
      if (!reasons.size) {
        throw new Error(
          "A duplicate-person query returned a record without a matching reason.",
        );
      }
      return {
        personId: row.personId,
        name: row.name,
        email: row.email,
        reasons: [...reasons],
        currentEvent: Boolean(row.currentEvent),
        scopes: row.scopeNames?.split(",").filter(Boolean) ?? [],
      };
    });

    return {
      enabled: true,
      matches,
      truncated: rows.results.length > 20,
    };
  }
}
