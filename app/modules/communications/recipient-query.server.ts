import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import type {
  AudienceType,
  CommunicationCategory,
} from "./communication-schema";

const emailSchema = z.email();

type RecipientRow = {
  personId: string | null;
  address: string;
  name: string | null;
  sourceId: string | null;
};

export type CommunicationRecipient = {
  personId: string | null;
  address: string;
  name: string;
  sourceId: string | null;
};

export type RecipientPreview = {
  selected: number;
  deliverable: CommunicationRecipient[];
  invalid: Array<{ address: string; name: string }>;
  suppressed: CommunicationRecipient[];
};

function parseManualRecipients(input: string): RecipientRow[] {
  return input
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const named = part.match(/^(.*?)\s*<([^>]+)>$/);
      return named
        ? {
            personId: null,
            name: named[1].trim() || null,
            address: named[2].trim(),
            sourceId: null,
          }
        : { personId: null, name: null, address: part, sourceId: null };
    });
}

export class RecipientLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `The audience exceeds the current safe batch limit of ${limit.toLocaleString()} recipients. Narrow the audience and send another batch.`,
    );
    this.name = "RecipientLimitError";
  }
}

export class RecipientQuery {
  static readonly maximumBatchSize = 5_000;

  constructor(private readonly env: CloudflareEnvironment) {}

  async preview(
    viewer: Viewer,
    {
      audienceType,
      manualRecipients,
      category,
      kind,
    }: {
      audienceType: AudienceType;
      manualRecipients: string;
      category: CommunicationCategory;
      kind: "transactional" | "optional";
    },
  ): Promise<RecipientPreview> {
    const rows =
      audienceType === "manual"
        ? parseManualRecipients(manualRecipients)
        : await this.queryAudience(viewer, audienceType);

    const byAddress = new Map<string, RecipientRow>();
    for (const row of rows) {
      const key = row.address.trim().toLocaleLowerCase("en");
      if (!byAddress.has(key))
        byAddress.set(key, { ...row, address: row.address.trim() });
    }
    if (byAddress.size > RecipientQuery.maximumBatchSize)
      throw new RecipientLimitError(RecipientQuery.maximumBatchSize);

    const invalid: RecipientPreview["invalid"] = [];
    const valid: CommunicationRecipient[] = [];
    for (const row of byAddress.values()) {
      if (!emailSchema.safeParse(row.address).success) {
        invalid.push({ address: row.address, name: row.name ?? "" });
        continue;
      }
      valid.push({
        personId: row.personId,
        address: row.address.toLocaleLowerCase("en"),
        name: row.name?.trim() || row.address,
        sourceId: row.sourceId,
      });
    }

    const suppressedAddresses = valid.length
      ? await this.getSuppressed(
          viewer,
          valid.map((recipient) => recipient.address),
          category,
          kind,
        )
      : new Set<string>();
    const suppressed = valid.filter((recipient) =>
      suppressedAddresses.has(recipient.address),
    );
    const deliverable = valid.filter(
      (recipient) => !suppressedAddresses.has(recipient.address),
    );
    return { selected: byAddress.size, deliverable, invalid, suppressed };
  }

  private async queryAudience(
    viewer: Viewer,
    audienceType: Exclude<AudienceType, "manual">,
  ) {
    const queries: Record<
      typeof audienceType,
      { sql: string; bindings: unknown[] }
    > = {
      submitted_applicants: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT s.submitter_person_id AS personId,
                     COALESCE(p.email, s.submitter_email, '') AS address,
                     COALESCE(p.display_name, s.submitter_email, '') AS name,
                     s.id AS sourceId,
                     ROW_NUMBER() OVER (
                       PARTITION BY lower(COALESCE(p.email, s.submitter_email, ''))
                       ORDER BY s.updated_at DESC, s.id
                     ) AS recipientRank
                FROM submissions s
                JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
                LEFT JOIN people p ON p.id = s.submitter_person_id
               WHERE s.event_id = ?
                 AND s.status IN ('submitted','assigned','in_review','decision_ready')
                 AND COALESCE(p.email, s.submitter_email) IS NOT NULL
            ) recipients
           WHERE recipientRank = 1
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      decision_recipients: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT s.submitter_person_id AS personId,
                     COALESCE(p.email, s.submitter_email, '') AS address,
                     COALESCE(p.display_name, s.submitter_email, '') AS name,
                     s.id AS sourceId,
                     ROW_NUMBER() OVER (
                       PARTITION BY lower(COALESCE(p.email, s.submitter_email, ''))
                       ORDER BY s.updated_at DESC, s.id
                     ) AS recipientRank
                FROM submissions s
                JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
                LEFT JOIN people p ON p.id = s.submitter_person_id
               WHERE s.event_id = ?
                 AND s.status IN ('accepted','waitlisted','rejected')
                 AND COALESCE(p.email, s.submitter_email) IS NOT NULL
            ) recipients
           WHERE recipientRank = 1
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      accepted_speakers: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT candidates.*,
                     ROW_NUMBER() OVER (
                       PARTITION BY lower(candidates.address)
                       ORDER BY candidates.sourcePriority, candidates.sourceId
                     ) AS recipientRank
                FROM (
                  SELECT ss.person_id AS personId, ss.email AS address,
                         ss.display_name AS name, ss.submission_id AS sourceId,
                         0 AS sourcePriority
                    FROM submission_speakers ss
                    JOIN submissions s ON s.id = ss.submission_id AND s.event_id = ss.event_id
                    JOIN events e ON e.id = ss.event_id AND e.organisation_id = ?
                   WHERE ss.event_id = ? AND s.status = 'accepted'
                  UNION ALL
                  SELECT p.id AS personId, p.email AS address,
                         p.display_name AS name, sp.session_id AS sourceId,
                         1 AS sourcePriority
                    FROM session_speakers sp
                    JOIN people p ON p.id = sp.person_id
                    JOIN sessions s ON s.id = sp.session_id AND s.event_id = sp.event_id
                    JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
                   WHERE sp.event_id = ? AND s.status IN ('unscheduled','scheduled','published')
                ) candidates
            ) recipients
           WHERE recipientRank = 1 AND trim(address) <> ''
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      incomplete_speakers: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT p.id AS personId, p.email AS address,
                     p.display_name AS name, t.id AS sourceId,
                     CASE
                       WHEN t.status = 'overdue'
                         OR (t.due_at IS NOT NULL AND t.due_at < unixepoch()) THEN 0
                       WHEN t.due_at IS NOT NULL THEN 1
                       ELSE 2
                     END AS urgencyRank,
                     t.due_at AS dueAt,
                     ROW_NUMBER() OVER (
                       PARTITION BY p.id
                       ORDER BY
                         CASE
                           WHEN t.status = 'overdue'
                             OR (t.due_at IS NOT NULL AND t.due_at < unixepoch()) THEN 0
                           WHEN t.due_at IS NOT NULL THEN 1
                           ELSE 2
                         END,
                         t.due_at,
                         t.id
                     ) AS recipientRank
                FROM task_instances t
                JOIN people p ON p.id = t.target_id
                JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
               WHERE t.event_id = ?
                 AND t.target_type = 'speaker'
                 AND t.status NOT IN ('completed','waived')
            ) recipients
           WHERE recipientRank = 1
           ORDER BY urgencyRank, dueAt, sourceId
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      due_speakers: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT p.id AS personId, p.email AS address,
                     p.display_name AS name, t.id AS sourceId,
                     ROW_NUMBER() OVER (
                       PARTITION BY p.id ORDER BY t.due_at, t.id
                     ) AS recipientRank
                FROM task_instances t
                JOIN people p ON p.id = t.target_id
                JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
               WHERE t.event_id = ? AND t.target_type = 'speaker'
                 AND t.status NOT IN ('submitted','completed','waived','overdue')
                 AND t.due_at >= unixepoch()
                 AND t.due_at < unixepoch() + 86400
            ) recipients
           WHERE recipientRank = 1
           ORDER BY sourceId
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      overdue_speakers: {
        sql: `
          SELECT personId, address, name, sourceId
            FROM (
              SELECT p.id AS personId, p.email AS address,
                     p.display_name AS name, t.id AS sourceId,
                     ROW_NUMBER() OVER (
                       PARTITION BY p.id ORDER BY t.due_at, t.id
                     ) AS recipientRank
                FROM task_instances t
                JOIN people p ON p.id = t.target_id
                JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
               WHERE t.event_id = ? AND t.target_type = 'speaker'
                 AND t.status NOT IN ('submitted','completed','waived')
                 AND t.due_at < unixepoch()
            ) recipients
           WHERE recipientRank = 1
           ORDER BY sourceId
           LIMIT ?
        `,
        bindings: [
          viewer.organisationId,
          viewer.eventId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
      event_administrators: {
        sql: `
          SELECT personId, address, name, NULL AS sourceId
            FROM (
              SELECT p.id AS personId, p.email AS address, p.display_name AS name,
                     ROW_NUMBER() OVER (
                       PARTITION BY lower(p.email)
                       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.id
                     ) AS recipientRank
                FROM memberships m
                JOIN people p ON p.id = m.person_id
                JOIN events e ON e.organisation_id = m.organisation_id
               WHERE e.id = ? AND e.organisation_id = ?
                 AND (
                   m.event_id = e.id
                   OR (m.event_id IS NULL AND m.role IN ('owner','administrator'))
                 )
                 AND m.role IN ('owner','administrator')
                 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
            ) recipients
           WHERE recipientRank = 1
           LIMIT ?
        `,
        bindings: [
          viewer.eventId,
          viewer.organisationId,
          RecipientQuery.maximumBatchSize + 1,
        ],
      },
    };
    const query = queries[audienceType];
    const result = await this.env.DB.prepare(query.sql)
      .bind(...query.bindings)
      .all<RecipientRow>();
    if (result.results.length > RecipientQuery.maximumBatchSize)
      throw new RecipientLimitError(RecipientQuery.maximumBatchSize);
    return result.results;
  }

  private async getSuppressed(
    viewer: Viewer,
    addresses: string[],
    category: CommunicationCategory,
    kind: "transactional" | "optional",
  ) {
    const result = await this.env.DB.prepare(
      `
      SELECT lower(u.address) AS address
        FROM communication_unsubscribes u
        JOIN events e ON e.id = u.event_id AND e.organisation_id = ?
       WHERE u.event_id = ? AND u.revoked_at IS NULL
         AND (u.category = '*' OR (? = 'optional' AND u.category = ?))
         AND lower(u.address) IN (SELECT lower(value) FROM json_each(?))
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        kind,
        category,
        JSON.stringify(addresses),
      )
      .all<{ address: string }>();
    return new Set(result.results.map((row) => row.address));
  }
}
