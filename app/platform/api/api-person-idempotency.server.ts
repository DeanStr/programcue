import { z } from "zod";

import { ApiError, apiRequestHash } from "./api.server";
import type { Viewer } from "~/platform/auth/authorize.server";

type StoredCommand = {
  id: string;
  requestHash: string;
  status: "processing" | "completed" | "failed";
  responseJson: string | null;
};

const storedJsonSchema = z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({
      code: "custom",
      message: "The stored command response is not valid JSON",
    });
    return z.NEVER;
  }
});

export type PersonCommandOptions<Result, Stored = Result> = {
  viewer: Viewer;
  scope: string;
  idempotencyKey: string;
  input: unknown;
  execute: (commandId: string) => Promise<Result>;
  /**
   * Reconstructs the canonical result after the owning mutation committed but
   * the response record did not. It must return null while the mutation has
   * not committed; callers then receive an explicit in-progress response.
   */
  recover: (commandId: string) => Promise<Result | null>;
  store?: (result: Result) => Promise<Stored> | Stored;
  restore?: (stored: Stored) => Promise<Result> | Result;
};

function actorId(viewer: Viewer) {
  return `person:${viewer.personId}`;
}

function serialize(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("An API command result must be JSON serializable.");
  }
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1_024) {
    throw new TypeError("An API command result cannot exceed 64 KB.");
  }
  return serialized;
}

function isCommittedFailure(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "committed" in error &&
      error.committed === true,
  );
}

/**
 * Idempotency boundary for same-origin, real-person API commands.
 *
 * The owning command receives the durable command id and its recovery probe is
 * consulted before a processing record is ever re-executed. This closes the
 * response-persistence crash window without a second mutation or a fabricated
 * success. Commands that have not committed fail explicitly as in progress.
 */
export class ApiPersonIdempotencyService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async load(viewer: Viewer, scope: string, idempotencyKey: string) {
    return this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status,
              response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        actorId(viewer),
        scope,
        idempotencyKey,
      )
      .first<StoredCommand>();
  }

  private async complete<Result, Stored>(
    options: PersonCommandOptions<Result, Stored>,
    command: StoredCommand,
    result: Result,
  ) {
    const stored = options.store
      ? await options.store(result)
      : (result as unknown as Stored);
    const updated = await this.env.DB.prepare(
      `UPDATE idempotency_records
          SET status = 'completed', response_status = 200,
              response_json = ?, completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND scope = ? AND idempotency_key = ?
          AND request_hash = ? AND status = 'processing'`,
    )
      .bind(
        serialize(stored),
        command.id,
        options.viewer.organisationId,
        options.viewer.eventId,
        actorId(options.viewer),
        options.scope,
        options.idempotencyKey,
        command.requestHash,
      )
      .run();
    if ((updated.meta.changes ?? 0) !== 1) {
      const converged = await this.load(
        options.viewer,
        options.scope,
        options.idempotencyKey,
      );
      if (!converged || converged.status !== "completed") {
        throw new Error(
          "The API command committed, but its durable result could not be recorded.",
        );
      }
      return this.replay(options, converged);
    }
    return result;
  }

  private async replay<Result, Stored>(
    options: PersonCommandOptions<Result, Stored>,
    command: StoredCommand,
  ) {
    if (!command.responseJson) {
      throw new Error(
        "The completed API idempotency record is missing its response.",
      );
    }
    const decoded = storedJsonSchema.parse(command.responseJson) as Stored;
    return options.restore
      ? await options.restore(decoded)
      : (decoded as unknown as Result);
  }

  private async recordCommittedFailure<Result, Stored>(
    options: PersonCommandOptions<Result, Stored>,
    command: StoredCommand,
  ) {
    const failed = await this.env.DB.prepare(
      `UPDATE idempotency_records
          SET status = 'failed', response_status = 503,
              response_json = NULL, completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND scope = ? AND idempotency_key = ?
          AND request_hash = ? AND status = 'processing'`,
    )
      .bind(
        command.id,
        options.viewer.organisationId,
        options.viewer.eventId,
        actorId(options.viewer),
        options.scope,
        options.idempotencyKey,
        command.requestHash,
      )
      .run();
    if ((failed.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The API command committed only partially, but its durable failure state could not be recorded.",
      );
    }
  }

  private committedFailure() {
    return new ApiError(
      503,
      "IDEMPOTENCY_COMMITTED_PARTIAL",
      "This command committed only partially. Resolve the dependency or recovery operation, then submit a new explicit command with a new Idempotency-Key.",
      { committed: true },
    );
  }

  async run<Result, Stored = Result>(
    options: PersonCommandOptions<Result, Stored>,
  ): Promise<{ result: Result; replayed: boolean }> {
    const requestHash = await apiRequestHash(options.input);
    const commandId = crypto.randomUUID();
    const [, inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        options.viewer.organisationId,
        options.viewer.eventId,
        actorId(options.viewer),
        options.scope,
        options.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 604800, unixepoch())`,
      ).bind(
        commandId,
        options.viewer.organisationId,
        options.viewer.eventId,
        actorId(options.viewer),
        options.scope,
        options.idempotencyKey,
        requestHash,
      ),
    ]);
    const command = await this.load(
      options.viewer,
      options.scope,
      options.idempotencyKey,
    );
    if (!command) {
      throw new Error("The API idempotency claim could not be recorded.");
    }
    if (command.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request",
      );
    }
    if (command.status === "completed") {
      return { result: await this.replay(options, command), replayed: true };
    }
    if (command.status === "failed") {
      throw this.committedFailure();
    }
    if ((inserted.meta.changes ?? 0) !== 1) {
      const recovered = await options.recover(command.id);
      if (recovered !== null) {
        return {
          result: await this.complete(options, command, recovered),
          replayed: true,
        };
      }
      throw new ApiError(
        409,
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "The command with this Idempotency-Key is still being processed",
      );
    }

    try {
      const result = await options.execute(command.id);
      return {
        result: await this.complete(options, command, result),
        replayed: false,
      };
    } catch (error) {
      if (isCommittedFailure(error)) {
        await this.recordCommittedFailure(options, command);
        throw error;
      }
      const recovered = await options.recover(command.id);
      if (recovered !== null) {
        return {
          result: await this.complete(options, command, recovered),
          replayed: false,
        };
      }
      await this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND status = 'processing'`,
      )
        .bind(
          command.id,
          options.viewer.organisationId,
          options.viewer.eventId,
          actorId(options.viewer),
        )
        .run();
      throw error;
    }
  }
}
