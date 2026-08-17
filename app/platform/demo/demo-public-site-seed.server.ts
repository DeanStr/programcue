import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import {
  DEMO_SHOWCASE_FEATURED_SESSION_IDS,
  DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
  DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID,
  DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
  DEMO_SHOWCASE_SITE_SPONSORS,
  DEMO_SHOWCASE_TIMESTAMP,
  demoShowcasePublicSiteDraft,
  demoShowcasePublishedPublicSite,
} from "~/platform/demo/demo-reset-fixtures";

const SHOWCASE_PUBLIC_SITE_GENERATION_SQL = `SELECT 1 FROM event_public_sites
     WHERE event_id = ? AND organisation_id = ?
       AND draft_revision = 1 AND published_revision = 1
       AND last_operation_id = ?`;

const showcasePublicSiteGenerationBindings = [
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
] as const;

const showcaseSponsorIds = DEMO_SHOWCASE_SITE_SPONSORS.map(
  (sponsor) => sponsor.id,
);
const showcaseFeaturedReferenceCount =
  DEMO_SHOWCASE_FEATURED_SESSION_IDS.length +
  DEMO_SHOWCASE_FEATURED_SPEAKER_IDS.length;

function sqlPlaceholders(values: readonly string[]) {
  return values.map(() => "?").join(", ");
}

export async function ensureDemoPublicSite(env: CloudflareEnvironment) {
  const featuredReferences = [
    ...DEMO_SHOWCASE_FEATURED_SESSION_IDS.map((recordId) => ({
      kind: "session" as const,
      recordId,
    })),
    ...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS.map((recordId) => ({
      kind: "speaker" as const,
      recordId,
    })),
  ];
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO event_public_sites (
           event_id, organisation_id, draft_json, draft_revision,
           published_json, published_revision, published_at,
           last_updated_by_person_id, last_operation_id, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        DEMO_EVENT_ID,
        DEMO_ORGANISATION_ID,
        JSON.stringify(demoShowcasePublicSiteDraft()),
        JSON.stringify(demoShowcasePublishedPublicSite()),
        DEMO_SHOWCASE_TIMESTAMP - 600,
        DEMO_IDENTITIES.owner.personId,
        DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        DEMO_SHOWCASE_TIMESTAMP - 600,
        DEMO_SHOWCASE_TIMESTAMP - 600,
      ),
      ...DEMO_SHOWCASE_SITE_SPONSORS.map((sponsor) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO event_site_sponsors (
             id, organisation_id, event_id, name, tier, website_url, logo_url,
             description, position, revision, last_updated_by_person_id,
             last_operation_id, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
              WHERE EXISTS (${SHOWCASE_PUBLIC_SITE_GENERATION_SQL})`,
        ).bind(
          sponsor.id,
          DEMO_ORGANISATION_ID,
          DEMO_EVENT_ID,
          sponsor.name,
          sponsor.tier,
          sponsor.websiteUrl,
          sponsor.logoUrl,
          sponsor.description,
          sponsor.position,
          DEMO_IDENTITIES.owner.personId,
          sponsor.operationId,
          DEMO_SHOWCASE_TIMESTAMP - 620,
          DEMO_SHOWCASE_TIMESTAMP - 620,
          ...showcasePublicSiteGenerationBindings,
        ),
      ),
      ...featuredReferences.map((reference) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO event_public_site_references (
             event_id, organisation_id, kind, record_id, site_revision
           ) SELECT ?, ?, ?, ?, 1
              WHERE EXISTS (${SHOWCASE_PUBLIC_SITE_GENERATION_SQL})`,
        ).bind(
          DEMO_EVENT_ID,
          DEMO_ORGANISATION_ID,
          reference.kind,
          reference.recordId,
          ...showcasePublicSiteGenerationBindings,
        ),
      ),
      env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         ) SELECT ?, 'public_site', ?, 'published', ?, ?
            WHERE EXISTS (${SHOWCASE_PUBLIC_SITE_GENERATION_SQL})
              AND NOT EXISTS (
                SELECT 1 FROM event_changes existing
                 WHERE existing.event_id = ?
                   AND existing.entity_type = 'public_site'
                   AND existing.entity_id = ?
                   AND existing.change_type = 'published'
                   AND existing.correlation_id = ?
              )`,
      ).bind(
        DEMO_EVENT_ID,
        DEMO_EVENT_ID,
        DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        DEMO_SHOWCASE_TIMESTAMP - 600,
        ...showcasePublicSiteGenerationBindings,
        DEMO_EVENT_ID,
        DEMO_EVENT_ID,
        DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'internal', 1, ?, ?, ?, 'public_site.published',
                'public_site', ?, ?, ?, ?
           WHERE EXISTS (${SHOWCASE_PUBLIC_SITE_GENERATION_SQL})`,
      ).bind(
        DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        DEMO_IDENTITIES.owner.personId,
        DEMO_EVENT_ID,
        DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        JSON.stringify({
          revision: 1,
          sections: [
            "introduction",
            "featured_speakers",
            "featured_sessions",
            "statistics",
            "venue",
            "faq",
          ],
          pages: ["about", "sponsors"],
          sponsorCount: DEMO_SHOWCASE_SITE_SPONSORS.length,
        }),
        DEMO_SHOWCASE_TIMESTAMP - 600,
        ...showcasePublicSiteGenerationBindings,
      ),
      atomicBatchGuardStatement(
        env,
        `EXISTS (${SHOWCASE_PUBLIC_SITE_GENERATION_SQL})
         AND (
           (SELECT COUNT(*) FROM event_site_sponsors
             WHERE event_id = ? AND id IN (${sqlPlaceholders(showcaseSponsorIds)})) <> ?
           OR (SELECT COUNT(*) FROM event_public_site_references
                WHERE event_id = ? AND site_revision = 1
                  AND (
                    (kind = 'session' AND record_id IN (${sqlPlaceholders(DEMO_SHOWCASE_FEATURED_SESSION_IDS)}))
                    OR (kind = 'speaker' AND record_id IN (${sqlPlaceholders(DEMO_SHOWCASE_FEATURED_SPEAKER_IDS)}))
                  )) <> ?
           OR NOT EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ? AND event_id = ?
           )
           OR NOT EXISTS (
             SELECT 1 FROM event_changes
              WHERE event_id = ? AND entity_type = 'public_site'
                AND entity_id = ? AND change_type = 'published'
                AND correlation_id = ?
           )
         )`,
        [
          ...showcasePublicSiteGenerationBindings,
          DEMO_EVENT_ID,
          ...showcaseSponsorIds,
          showcaseSponsorIds.length,
          DEMO_EVENT_ID,
          ...DEMO_SHOWCASE_FEATURED_SESSION_IDS,
          ...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
          showcaseFeaturedReferenceCount,
          DEMO_SHOWCASE_PUBLIC_SITE_AUDIT_ID,
          DEMO_EVENT_ID,
          DEMO_EVENT_ID,
          DEMO_EVENT_ID,
          DEMO_SHOWCASE_PUBLIC_SITE_OPERATION_ID,
        ],
      ),
    ]);
  } catch (error) {
    if (isAtomicBatchGuardError(error)) {
      throw new Error("The demo public-site showcase is incomplete.");
    }
    throw error;
  }
}
