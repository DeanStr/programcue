import type { Viewer } from "~/platform/auth/authorize.server";
import {
  evaluationDiscussionMessageSchema,
  evaluationDiscussionPageSchema,
} from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  type EvaluationApiCommand,
} from "./evaluation-service-foundation.server";
import { EvaluationStateError } from "./evaluation-errors";

type DiscussionTarget = {
  roundId: string;
  targetType: "submission" | "session";
  targetId: string;
};

type DiscussionScope = DiscussionTarget & {
  roundStatus: string;
  planStatus: string;
  manager: boolean;
  reviewerEligible: boolean;
};

type DiscussionReplay = {
  id: string;
  createdAt: number;
  roundId: string;
  submissionId: string | null;
  sessionId: string | null;
  body: string | null;
};

export type EvaluationDiscussionPage = {
  target: DiscussionTarget;
  writable: boolean;
  messages: Array<{
    id: string;
    body: string;
    createdAt: number;
    authorName: string;
    authorPersonId: string;
  }>;
  earlierCursor: string | null;
  postIntentId: string;
};

const DISCUSSION_PAGE_SIZE = 50;

type DiscussionCursor = DiscussionTarget & {
  version: 1;
  createdAt: number;
  id: string;
};

function encodeCursor(cursor: Omit<DiscussionCursor, "version">) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, ...cursor } satisfies DiscussionCursor),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(value: string | undefined, target: DiscussionTarget) {
  if (!value) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    ) as Partial<DiscussionCursor>;
    if (
      decoded.version !== 1 ||
      !Number.isSafeInteger(decoded.createdAt) ||
      decoded.createdAt! < 0 ||
      typeof decoded.id !== "string" ||
      !decoded.id.length ||
      decoded.id.length > 200 ||
      decoded.roundId !== target.roundId ||
      decoded.targetType !== target.targetType ||
      decoded.targetId !== target.targetId
    ) {
      throw new Error("invalid cursor shape");
    }
    return { createdAt: decoded.createdAt!, id: decoded.id };
  } catch {
    throw new Response("Discussion page cursor is invalid.", { status: 400 });
  }
}

function targetColumn(targetType: DiscussionTarget["targetType"]) {
  return targetType === "submission" ? "submission_id" : "session_id";
}

function targetTable(targetType: DiscussionTarget["targetType"]) {
  return targetType === "submission" ? "submissions" : "sessions";
}

export class EvaluationDiscussionWorkflows extends EvaluationServiceFoundation {
  async listDiscussion(
    viewer: Viewer,
    input: unknown,
  ): Promise<EvaluationDiscussionPage> {
    const parsed = evaluationDiscussionPageSchema.parse(input);
    return this.readAuthoritative(viewer, async () => {
      const scope = await this.discussionScope(viewer, parsed);
      this.assertCanRead(scope);
      const column = targetColumn(parsed.targetType);
      const cursor = decodeCursor(parsed.cursor, parsed);
      const messages = await this.env.DB.prepare(
        `SELECT message.id, message.body, message.created_at AS createdAt,
                person.display_name AS authorName,
                message.author_person_id AS authorPersonId
           FROM evaluation_discussion_messages message
           JOIN evaluation_rounds round
             ON round.id = message.round_id AND round.event_id = message.event_id
           JOIN events event
             ON event.id = message.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = message.author_person_id
          WHERE message.event_id = ? AND message.round_id = ?
            AND message.${column} = ?
            AND (
              ? IS NULL OR message.created_at < ?
              OR (message.created_at = ? AND message.id < ?)
            )
          ORDER BY message.created_at DESC, message.id DESC
          LIMIT ?`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          parsed.roundId,
          parsed.targetId,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          DISCUSSION_PAGE_SIZE + 1,
        )
        .all<{
          id: string;
          body: string | null;
          createdAt: number;
          authorName: string;
          authorPersonId: string;
        }>();
      const page = messages.results.slice(0, DISCUSSION_PAGE_SIZE);
      const oldest = page.at(-1);
      return {
        target: {
          roundId: parsed.roundId,
          targetType: parsed.targetType,
          targetId: parsed.targetId,
        },
        writable: this.canPost(scope),
        messages: page
          .map((message) => ({
            ...message,
            body: message.body ?? "[redacted after event retention]",
          }))
          .reverse(),
        earlierCursor:
          messages.results.length > DISCUSSION_PAGE_SIZE && oldest
            ? encodeCursor({
                roundId: parsed.roundId,
                targetType: parsed.targetType,
                targetId: parsed.targetId,
                createdAt: oldest.createdAt,
                id: oldest.id,
              })
            : null,
        postIntentId: crypto.randomUUID(),
      };
    });
  }

  async addDiscussionMessage(
    viewer: Viewer,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    const parsed = evaluationDiscussionMessageSchema.parse(input);
    return this.projectCommand(
      viewer,
      "evaluation.discussion.add",
      parsed,
      command,
      async () => {
        const scope = await this.discussionScope(viewer, parsed);
        this.assertCanRead(scope);
        const replay = await this.findReplay(viewer, parsed.idempotencyKey);
        if (replay) return this.replayResult(replay, parsed);
        if (!this.canPost(scope)) {
          throw new EvaluationStateError(
            "Discussion is read-only for this round and review state.",
          );
        }

        const column = targetColumn(parsed.targetType);
        const table = targetTable(parsed.targetType);
        const manager = scope.manager ? 1 : 0;
        const messageId = crypto.randomUUID();
        const auditId = crypto.randomUUID();
        let results: D1Result<unknown>[];
        try {
          results = await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT INTO audit_events (
               id, organisation_id, event_id, actor_person_id, action,
               entity_type, entity_id, metadata_json, created_at
             )
             SELECT ?, ?, round.event_id, ?, 'evaluation.discussion.message.added',
                    'evaluation_discussion_message', ?,
                    json_object(
                      'roundId', round.id,
                      'targetType', ?,
                      'targetId', ?
                    ), unixepoch()
               FROM evaluation_rounds round
               JOIN evaluation_plans plan
                 ON plan.id = round.plan_id AND plan.event_id = round.event_id
               JOIN events event
                 ON event.id = round.event_id AND event.organisation_id = ?
              WHERE round.id = ? AND round.event_id = ?
                AND round.status IN ('active','closed')
                AND plan.status IN ('active','closed')
                AND EXISTS (
                  SELECT 1 FROM ${table} target
                   WHERE target.id = ? AND target.event_id = round.event_id
                )
                AND (
                  ? = 1 OR EXISTS (
                    SELECT 1
                      FROM evaluator_assignments assignment
                      JOIN reviews review
                        ON review.assignment_id = assignment.id
                       AND review.event_id = assignment.event_id
                     WHERE assignment.event_id = round.event_id
                       AND assignment.round_id = round.id
                       AND assignment.${column} = ?
                       AND assignment.evaluator_person_id = ?
                       AND assignment.status = 'submitted'
                       AND review.status IN ('submitted','locked')
                  )
                )`,
            ).bind(
              auditId,
              viewer.organisationId,
              viewer.personId,
              messageId,
              parsed.targetType,
              parsed.targetId,
              viewer.organisationId,
              parsed.roundId,
              viewer.eventId,
              parsed.targetId,
              manager,
              parsed.targetId,
              viewer.personId,
            ),
            this.env.DB.prepare(
              `INSERT INTO evaluation_discussion_messages (
               id, event_id, round_id, submission_id, session_id,
               author_person_id, body, idempotency_key, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = ? AND audit.organisation_id = ?
                   AND audit.event_id = ?
                   AND audit.action = 'evaluation.discussion.message.added'
                   AND audit.entity_id = ?
              )`,
            ).bind(
              messageId,
              viewer.eventId,
              parsed.roundId,
              parsed.targetType === "submission" ? parsed.targetId : null,
              parsed.targetType === "session" ? parsed.targetId : null,
              viewer.personId,
              parsed.body,
              parsed.idempotencyKey,
              auditId,
              viewer.organisationId,
              viewer.eventId,
              messageId,
            ),
          ]);
        } catch (error) {
          const concurrentReplay = await this.findReplay(
            viewer,
            parsed.idempotencyKey,
          );
          if (concurrentReplay) {
            return this.replayResult(concurrentReplay, parsed);
          }
          throw error;
        }
        const [audit, message] = results;
        if (
          (audit.meta.changes ?? 0) !== 1 ||
          (message.meta.changes ?? 0) !== 1
        ) {
          throw new EvaluationStateError(
            "The round, target, or review state changed before the message could be added.",
          );
        }
        const stored = await this.env.DB.prepare(
          `SELECT created_at AS createdAt
             FROM evaluation_discussion_messages
            WHERE id = ? AND event_id = ?`,
        )
          .bind(messageId, viewer.eventId)
          .first<{ createdAt: number }>();
        if (!stored) {
          throw new Error("The discussion message was not persisted.");
        }
        return { id: messageId, createdAt: stored.createdAt, replayed: false };
      },
    );
  }

  private async findReplay(viewer: Viewer, idempotencyKey: string) {
    return this.env.DB.prepare(
      `SELECT message.id, message.created_at AS createdAt,
              message.round_id AS roundId,
              message.submission_id AS submissionId,
              message.session_id AS sessionId, message.body
         FROM evaluation_discussion_messages message
         JOIN events event
           ON event.id = message.event_id AND event.organisation_id = ?
        WHERE message.event_id = ? AND message.author_person_id = ?
          AND message.idempotency_key = ?`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        idempotencyKey,
      )
      .first<DiscussionReplay>();
  }

  private replayResult(
    replay: DiscussionReplay,
    input: DiscussionTarget & { body: string },
  ) {
    const targetMatches =
      input.targetType === "submission"
        ? replay.submissionId === input.targetId && replay.sessionId === null
        : replay.sessionId === input.targetId && replay.submissionId === null;
    if (
      replay.roundId !== input.roundId ||
      !targetMatches ||
      replay.body !== input.body
    ) {
      throw new EvaluationStateError(
        "This discussion intent was already used for a different message. Refresh before trying again.",
      );
    }
    return { id: replay.id, createdAt: replay.createdAt, replayed: true };
  }

  private async discussionScope(
    viewer: Viewer,
    target: DiscussionTarget,
  ): Promise<DiscussionScope> {
    await this.assertViewerEvent(viewer);
    const table = targetTable(target.targetType);
    const column = targetColumn(target.targetType);
    const round = await this.env.DB.prepare(
      `SELECT round.status AS roundStatus, plan.status AS planStatus,
              EXISTS (
                SELECT 1 FROM ${table} target
                 WHERE target.id = ? AND target.event_id = round.event_id
              ) AS targetExists,
              EXISTS (
                SELECT 1
                  FROM evaluator_assignments assignment
                  JOIN reviews review
                    ON review.assignment_id = assignment.id
                   AND review.event_id = assignment.event_id
                 WHERE assignment.event_id = round.event_id
                   AND assignment.round_id = round.id
                   AND assignment.${column} = ?
                   AND assignment.evaluator_person_id = ?
                   AND assignment.status = 'submitted'
                   AND review.status IN ('submitted','locked')
              ) AS reviewerEligible
         FROM evaluation_rounds round
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         JOIN events event
           ON event.id = round.event_id AND event.organisation_id = ?
        WHERE round.id = ? AND round.event_id = ?`,
    )
      .bind(
        target.targetId,
        target.targetId,
        viewer.personId,
        viewer.organisationId,
        target.roundId,
        viewer.eventId,
      )
      .first<{
        roundStatus: string;
        planStatus: string;
        targetExists: number;
        reviewerEligible: number;
      }>();
    if (!round || !round.targetExists) {
      throw new Response("Evaluation discussion target not found.", {
        status: 404,
      });
    }
    return {
      ...target,
      roundStatus: round.roundStatus,
      planStatus: round.planStatus,
      manager:
        viewer.role === "owner" ||
        viewer.role === "administrator" ||
        viewer.role === "committee_chair",
      reviewerEligible: Boolean(round.reviewerEligible),
    };
  }

  private assertCanRead(scope: DiscussionScope) {
    if (!scope.manager && !scope.reviewerEligible) {
      throw new Response(
        "Submit your review for this exact round and target before joining its discussion.",
        { status: 403 },
      );
    }
  }

  private canPost(scope: DiscussionScope) {
    if (!scope.manager && !scope.reviewerEligible) return false;
    return (
      (scope.roundStatus === "active" || scope.roundStatus === "closed") &&
      (scope.planStatus === "active" || scope.planStatus === "closed")
    );
  }
}
