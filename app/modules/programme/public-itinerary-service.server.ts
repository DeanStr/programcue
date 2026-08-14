import { eventLocalEndOfDayEpoch } from "~/modules/schedule/schedule-time";
import { DEMO_EVENT_ID } from "~/platform/demo/demo-identities";
import type { PublishedProgramme } from "./public-programme-service.server";
import { eventVisitorKeyHash } from "./public-itinerary-token.server";

const encoder = new TextEncoder();
const EXPIRED_ITINERARY_CLEANUP_LIMIT = 100;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type ItineraryIdentity = {
  personId: string | null;
  visitorToken: string | null;
};

export class PublishedProgrammeSessionNotFoundError extends Error {
  constructor() {
    super("Published session not found.");
    this.name = "PublishedProgrammeSessionNotFoundError";
  }
}

export class PublishedProgrammeItineraryExpiredError extends Error {
  constructor() {
    super("This event's itinerary is no longer available.");
    this.name = "PublishedProgrammeItineraryExpiredError";
  }
}

export class PublishedProgrammeItineraryNotFoundError extends Error {
  constructor(
    message = "Save at least one session before sharing an itinerary.",
  ) {
    super(message);
    this.name = "PublishedProgrammeItineraryNotFoundError";
  }
}

export class PublicItineraryService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async itinerary(programme: PublishedProgramme, identity: ItineraryIdentity) {
    if (!identity.personId && !identity.visitorToken) return [] as string[];
    const visitorHash = identity.visitorToken
      ? await eventVisitorKeyHash(
          this.env,
          identity.visitorToken,
          programme.event.id,
        )
      : null;
    const rows = await this.env.DB.prepare(
      `
      SELECT DISTINCT i.session_id AS sessionId
        FROM public_itineraries p JOIN public_itinerary_items i ON i.itinerary_id = p.id
        JOIN schedule_entries se ON se.session_id = i.session_id AND se.event_id = p.event_id
        JOIN sessions session
          ON session.id = se.session_id AND session.event_id = se.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id
         AND content.session_id = se.session_id
        JOIN schedule_versions current_version
          ON current_version.id = se.schedule_version_id
         AND current_version.event_id = se.event_id
         AND current_version.status = 'published'
       WHERE p.event_id = ?
         AND ((? IS NOT NULL AND p.person_id = ?)
           OR (? IS NOT NULL AND p.person_id IS NULL AND p.visitor_key_hash = ?))
         AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
         AND se.schedule_version_id = ?
         AND session.status = 'published' AND content.visibility = 'public'
       ORDER BY se.starts_at, i.session_id
    `,
    )
      .bind(
        programme.event.id,
        identity.personId,
        identity.personId,
        visitorHash,
        visitorHash,
        programme.version.id,
      )
      .all<{ sessionId: string }>();
    return rows.results.map((row) => row.sessionId);
  }

  async itineraryIsSynced(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    if (!identity.personId) return false;
    if (!identity.visitorToken) return true;
    const visitorHash = await eventVisitorKeyHash(
      this.env,
      identity.visitorToken,
      programme.event.id,
    );
    const anonymous = await this.env.DB.prepare(
      `SELECT id FROM public_itineraries
        WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
          AND (expires_at IS NULL OR expires_at > unixepoch())`,
    )
      .bind(programme.event.id, visitorHash)
      .first<{ id: string }>();
    return anonymous === null;
  }

  async hasActiveAnonymousItinerary(
    programme: PublishedProgramme,
    visitorToken: string | null,
  ) {
    if (!visitorToken) return false;
    const visitorHash = await eventVisitorKeyHash(
      this.env,
      visitorToken,
      programme.event.id,
    );
    return Boolean(
      await this.env.DB.prepare(
        `SELECT 1 FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(programme.event.id, visitorHash)
        .first(),
    );
  }

  async sharedItinerary(programme: PublishedProgramme, shareToken: string) {
    if (!/^[0-9a-f-]{72}$/u.test(shareToken))
      throw new PublishedProgrammeItineraryNotFoundError(
        "This shared itinerary is unavailable or empty.",
      );
    const shareHash = await sha256(shareToken);
    const rows = await this.env.DB.prepare(
      `
      SELECT item.session_id AS sessionId
        FROM public_itineraries itinerary
        JOIN public_itinerary_items item ON item.itinerary_id = itinerary.id
        JOIN schedule_entries entry
          ON entry.session_id = item.session_id AND entry.event_id = itinerary.event_id
        JOIN sessions session
          ON session.id = entry.session_id AND session.event_id = entry.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = entry.schedule_version_id
         AND content.event_id = entry.event_id
         AND content.session_id = entry.session_id
        JOIN schedule_versions current_version
          ON current_version.id = entry.schedule_version_id
         AND current_version.event_id = entry.event_id
         AND current_version.status = 'published'
       WHERE itinerary.event_id = ? AND itinerary.share_token_hash = ?
         AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
         AND entry.schedule_version_id = ?
         AND session.status = 'published' AND content.visibility = 'public'
       ORDER BY entry.starts_at
    `,
    )
      .bind(programme.event.id, shareHash, programme.version.id)
      .all<{ sessionId: string }>();
    if (!rows.results.length)
      throw new PublishedProgrammeItineraryNotFoundError(
        "This shared itinerary is unavailable or empty.",
      );
    return rows.results.map((row) => row.sessionId);
  }

  private itineraryExpiresAt(programme: PublishedProgramme) {
    // The fixed demo programme is durable reference data rather than a live event.
    // The canonical production evaluation fixture is also fixed in 2025, so
    // keep it usable during evaluation without weakening expiry for real events.
    const now = Math.floor(Date.now() / 1_000);
    const evaluationFixture =
      String(this.env.EVALUATION_MODE) === "true" &&
      programme.event.id === DEMO_EVENT_ID;
    const expiresAt =
      String(this.env.DEMO_MODE) === "true"
        ? null
        : Math.max(
            eventLocalEndOfDayEpoch(
              Math.floor(
                Date.parse(`${programme.event.endDate}T00:00:00Z`) / 1_000,
              ),
              programme.event.timezone,
            ) +
              365 * 86_400,
            evaluationFixture ? now + 365 * 86_400 : 0,
          );
    if (expiresAt !== null && expiresAt <= now) {
      throw new PublishedProgrammeItineraryExpiredError();
    }
    return expiresAt;
  }

  async syncItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    if (!identity.personId)
      throw new Error("A signed-in person is required to sync an itinerary.");
    if (!identity.visitorToken) return;
    const visitorHash = await eventVisitorKeyHash(
      this.env,
      identity.visitorToken,
      programme.event.id,
    );
    const expiresAt = this.itineraryExpiresAt(programme);
    const [source, target] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(programme.event.id, visitorHash)
        .first<{ id: string }>(),
      this.env.DB.prepare(
        `SELECT id FROM public_itineraries
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(programme.event.id, identity.personId)
        .first<{ id: string }>(),
    ]);
    if (!source) return;

    if (!target) {
      const converted = await this.env.DB.prepare(
        `UPDATE public_itineraries
            SET person_id = ?, visitor_key_hash = NULL, expires_at = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
            AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(
          identity.personId,
          expiresAt,
          source.id,
          programme.event.id,
          visitorHash,
        )
        .run();
      if ((converted.meta.changes ?? 0) !== 1)
        throw new Error(
          "The anonymous itinerary changed before it could be synced.",
        );
      return;
    }

    const [renewed, , removed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE public_itineraries
            SET expires_at = ?,
                share_token_hash = COALESCE(
                  (
                    SELECT source.share_token_hash
                      FROM public_itineraries source
                     WHERE source.id = ? AND source.event_id = ?
                       AND source.visitor_key_hash = ?
                       AND source.person_id IS NULL
                       AND (source.expires_at IS NULL OR source.expires_at > unixepoch())
                  ),
                  share_token_hash
                ),
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND person_id = ?`,
      ).bind(
        expiresAt,
        source.id,
        programme.event.id,
        visitorHash,
        target.id,
        programme.event.id,
        identity.personId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO public_itinerary_items (
          itinerary_id, session_id, created_at
        )
        SELECT ?, item.session_id, unixepoch()
          FROM public_itineraries source
          JOIN public_itinerary_items item ON item.itinerary_id = source.id
          JOIN schedule_entries entry
            ON entry.event_id = source.event_id AND entry.session_id = item.session_id
          JOIN sessions session
            ON session.id = entry.session_id AND session.event_id = entry.event_id
          JOIN schedule_session_contents content
            ON content.schedule_version_id = entry.schedule_version_id
           AND content.event_id = entry.event_id
           AND content.session_id = entry.session_id
          JOIN schedule_versions current_version
            ON current_version.id = entry.schedule_version_id
           AND current_version.event_id = entry.event_id
           AND current_version.status = 'published'
         WHERE source.event_id = ? AND source.visitor_key_hash = ?
           AND source.person_id IS NULL
           AND (source.expires_at IS NULL OR source.expires_at > unixepoch())
           AND entry.schedule_version_id = ?
           AND session.status = 'published' AND content.visibility = 'public'
      `,
      ).bind(target.id, programme.event.id, visitorHash, programme.version.id),
      this.env.DB.prepare(
        `DELETE FROM public_itineraries
          WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
            AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())
            AND EXISTS (
              SELECT 1 FROM public_itineraries target
               WHERE target.id = ? AND target.event_id = ? AND target.person_id = ?
                 AND (target.expires_at IS NULL OR target.expires_at > unixepoch())
            )`,
      ).bind(
        source.id,
        programme.event.id,
        visitorHash,
        target.id,
        programme.event.id,
        identity.personId,
      ),
    ]);
    if (
      (renewed.meta.changes ?? 0) !== 1 ||
      (removed.meta.changes ?? 0) !== 1
    ) {
      throw new Error("The itinerary changed before it could be synced.");
    }
  }

  async updateItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
    sessionId: string,
    intent: "add" | "remove",
  ) {
    const published = programme.sessions.some(
      (session) => session.id === sessionId,
    );
    if (!published) throw new PublishedProgrammeSessionNotFoundError();
    const expiresAt = this.itineraryExpiresAt(programme);
    if (identity.personId && identity.visitorToken) {
      await this.syncItinerary(programme, identity);
    }
    if (identity.personId) {
      const itineraryId = crypto.randomUUID();
      if (intent === "add") {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO public_itineraries (
               id, event_id, person_id, expires_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
             ON CONFLICT(event_id, person_id) DO UPDATE SET
               expires_at = excluded.expires_at, updated_at = unixepoch()`,
          ).bind(itineraryId, programme.event.id, identity.personId, expiresAt),
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO public_itinerary_items (
               itinerary_id, session_id, created_at
             )
             SELECT itinerary.id, session.id, unixepoch()
               FROM public_itineraries itinerary
               JOIN sessions session ON session.id = ? AND session.event_id = itinerary.event_id
               JOIN schedule_entries entry
                 ON entry.session_id = session.id AND entry.event_id = session.event_id
               JOIN schedule_versions current_version
                 ON current_version.id = entry.schedule_version_id
                AND current_version.event_id = entry.event_id
                AND current_version.status = 'published'
               JOIN schedule_session_contents content
                 ON content.schedule_version_id = entry.schedule_version_id
                AND content.event_id = entry.event_id
                AND content.session_id = session.id
              WHERE itinerary.event_id = ? AND itinerary.person_id = ?
                AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
                AND entry.schedule_version_id = ?
                AND session.status = 'published' AND content.visibility = 'public'`,
          ).bind(
            sessionId,
            programme.event.id,
            identity.personId,
            programme.version.id,
          ),
        ]);
      } else {
        await this.env.DB.prepare(
          `DELETE FROM public_itinerary_items
            WHERE session_id = ? AND itinerary_id IN (
              SELECT id FROM public_itineraries
               WHERE event_id = ? AND person_id = ?
                 AND (expires_at IS NULL OR expires_at > unixepoch())
            )`,
        )
          .bind(sessionId, programme.event.id, identity.personId)
          .run();
      }
      return { token: null, expiresAt };
    }

    let token: string;
    let visitorHash: string;
    let existing: { id: string; expiresAt: number | null } | null = null;
    let expiredExistingId: string | null = null;
    if (identity.visitorToken) {
      const candidateHash = await eventVisitorKeyHash(
        this.env,
        identity.visitorToken,
        programme.event.id,
      );
      existing = await this.env.DB.prepare(
        `SELECT id, expires_at AS expiresAt FROM public_itineraries
            WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(programme.event.id, candidateHash)
        .first<{ id: string; expiresAt: number | null }>();
      const existingIsActive =
        existing !== null &&
        (existing.expiresAt === null ||
          existing.expiresAt > Math.floor(Date.now() / 1_000));
      token = identity.visitorToken;
      visitorHash = candidateHash;
      if (!existingIsActive) {
        expiredExistingId = existing?.id ?? null;
        existing = null;
      }
    } else {
      token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      visitorHash = await eventVisitorKeyHash(
        this.env,
        token,
        programme.event.id,
      );
    }
    const itineraryId = existing?.id ?? crypto.randomUUID();
    if (intent === "add") {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM public_itineraries
            WHERE id IN (
              SELECT id FROM public_itineraries
               WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
               ORDER BY expires_at, id
               LIMIT ?
            )`,
        ).bind(EXPIRED_ITINERARY_CLEANUP_LIMIT),
        this.env.DB.prepare(
          `DELETE FROM public_itineraries
            WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
              AND person_id IS NULL
              AND expires_at IS NOT NULL AND expires_at <= unixepoch()`,
        ).bind(expiredExistingId, programme.event.id, visitorHash),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itineraries (id, event_id, visitor_key_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`,
        ).bind(itineraryId, programme.event.id, visitorHash, expiresAt),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itinerary_items (itinerary_id, session_id, created_at)
          SELECT p.id, s.id, unixepoch()
             FROM public_itineraries p
             JOIN sessions s ON s.id = ? AND s.event_id = p.event_id
             JOIN schedule_entries entry
               ON entry.session_id = s.id AND entry.event_id = s.event_id
             JOIN schedule_versions current_version
               ON current_version.id = entry.schedule_version_id
              AND current_version.event_id = entry.event_id
              AND current_version.status = 'published'
             JOIN schedule_session_contents content
               ON content.schedule_version_id = entry.schedule_version_id
              AND content.event_id = entry.event_id
              AND content.session_id = s.id
            WHERE p.event_id = ? AND p.visitor_key_hash = ?
              AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
              AND entry.schedule_version_id = ?
              AND s.status = 'published' AND content.visibility = 'public'`,
        ).bind(
          sessionId,
          programme.event.id,
          visitorHash,
          programme.version.id,
        ),
      ]);
    } else if (existing) {
      await this.env.DB.prepare(
        `DELETE FROM public_itinerary_items
          WHERE itinerary_id = ? AND session_id = ?
            AND EXISTS (
              SELECT 1 FROM public_itineraries p
               WHERE p.id = public_itinerary_items.itinerary_id
                 AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
            )`,
      )
        .bind(itineraryId, sessionId)
        .run();
    }
    return { token: intent === "add" ? token : null, expiresAt };
  }

  async shareItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    const visitorHash = identity.visitorToken
      ? await eventVisitorKeyHash(
          this.env,
          identity.visitorToken,
          programme.event.id,
        )
      : null;
    const itinerary = await this.env.DB.prepare(
      `
      SELECT itinerary.id
        FROM public_itineraries itinerary
       WHERE itinerary.event_id = ?
         AND ((? IS NOT NULL AND itinerary.person_id = ?)
           OR (? IS NULL AND ? IS NOT NULL AND itinerary.visitor_key_hash = ?))
         AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
         AND EXISTS (
           SELECT 1 FROM public_itinerary_items item
           JOIN schedule_entries entry
             ON entry.session_id = item.session_id AND entry.event_id = itinerary.event_id
           JOIN sessions session
             ON session.id = entry.session_id AND session.event_id = entry.event_id
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.event_id = entry.event_id
            AND content.session_id = entry.session_id
           JOIN schedule_versions current_version
             ON current_version.id = entry.schedule_version_id
            AND current_version.event_id = entry.event_id
            AND current_version.status = 'published'
            WHERE item.itinerary_id = itinerary.id
              AND entry.schedule_version_id = ?
              AND session.status = 'published' AND content.visibility = 'public'
         )
       LIMIT 1
    `,
    )
      .bind(
        programme.event.id,
        identity.personId,
        identity.personId,
        identity.personId,
        visitorHash,
        visitorHash,
        programme.version.id,
      )
      .first<{ id: string }>();
    if (!itinerary) throw new PublishedProgrammeItineraryNotFoundError();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const hash = await sha256(token);
    const updated = await this.env.DB.prepare(
      `UPDATE public_itineraries
          SET share_token_hash = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?
          AND (expires_at IS NULL OR expires_at > unixepoch())`,
    )
      .bind(hash, itinerary.id, programme.event.id)
      .run();
    if ((updated.meta.changes ?? 0) !== 1)
      throw new PublishedProgrammeItineraryNotFoundError();
    return token;
  }
}
