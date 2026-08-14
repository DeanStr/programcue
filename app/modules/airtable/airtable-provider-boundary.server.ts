import type { Viewer } from "~/platform/auth/authorize.server";

import {
  AirtableEventDataRepository,
  type AirtableProjectionCommandResult,
  type AirtableEventDataSnapshot,
} from "./airtable-event-data-repository.server";

type EventScope = Pick<Viewer, "organisationId" | "eventId">;
type CommandScope = EventScope & { personId: string | null };

type AirtableProviderBoundaryDependencies = {
  repository?: AirtableEventDataRepository;
};

type AirtableCommandOptions = {
  replay?: "store" | "reject";
};

export type AirtableCommandIdentity = {
  idempotencyKey: string;
  operation: string;
  requestHash: string;
};

const MAX_STORED_COMMAND_RESULT_BYTES = 64 * 1024;

export class AirtableCommandReplayUnavailableError extends Error {
  readonly status = 409;
  readonly committed = true;

  constructor(reason: "not_recorded" | "sensitive") {
    super(
      reason === "sensitive"
        ? "This Airtable-backed command already succeeded, but its sensitive response cannot be replayed. Refresh the affected resource instead of repeating the mutation."
        : "This Airtable-backed command already succeeded before replay-safe response storage was available. Refresh the affected resource instead of repeating the mutation.",
    );
    this.name = "AirtableCommandReplayUnavailableError";
  }
}

export class AirtableReplayedCommittedCommandError extends Error {
  readonly committed = true;
  readonly status?: number;

  constructor(
    result: Extract<
      AirtableProjectionCommandResult,
      { kind: "committed_error" }
    >,
  ) {
    super(result.message);
    this.name = result.name;
    this.status = result.status;
  }
}

class AirtableEventScopeError extends Error {
  readonly status = 404;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  return value;
}

function serializeCommandResult(
  value: unknown,
): AirtableProjectionCommandResult {
  if (value === undefined) return { kind: "undefined" };
  let valueJson: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new TypeError("The command result is not JSON serializable.");
    valueJson = serialized;
  } catch (error) {
    throw new TypeError(
      `The command result cannot be stored for safe replay: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    new TextEncoder().encode(valueJson).byteLength >
    MAX_STORED_COMMAND_RESULT_BYTES
  )
    throw new TypeError(
      `The command result exceeds the ${MAX_STORED_COMMAND_RESULT_BYTES}-byte replay limit.`,
    );
  return { kind: "json", valueJson };
}

function committedErrorResult(error: object): AirtableProjectionCommandResult {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const name =
    typeof candidate.name === "string" && candidate.name
      ? candidate.name
      : "CommittedCommandError";
  const message =
    typeof candidate.message === "string"
      ? candidate.message.slice(0, 4_096)
      : "The domain command committed but reported an error.";
  return {
    kind: "committed_error",
    name,
    message,
    ...(typeof candidate.status === "number" &&
    Number.isInteger(candidate.status)
      ? { status: candidate.status }
      : {}),
  };
}

function replayCommandResult<T>(
  result: AirtableProjectionCommandResult | undefined,
): T {
  if (!result || result.kind === "unavailable")
    throw new AirtableCommandReplayUnavailableError(
      result?.kind === "unavailable" ? result.reason : "not_recorded",
    );
  if (result.kind === "committed_error")
    throw new AirtableReplayedCommittedCommandError(result);
  if (result.kind === "undefined") return undefined as T;
  return JSON.parse(result.valueJson) as T;
}

async function commandRequestHash(input: unknown) {
  const serialized = JSON.stringify(stableValue(input));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return hash;
}

export async function airtableCommandKey(
  operation: string,
  scope: EventScope & { personId?: string | null },
  input: unknown,
) {
  const hash = await commandRequestHash(input);
  return `airtable:${scope.eventId}:${operation}:actor:${scope.personId ?? "anonymous"}:${hash}`;
}

export async function airtableIntentCommand(
  operation: string,
  scope: EventScope & { personId?: string | null },
  intentId: string,
  input: unknown,
): Promise<AirtableCommandIdentity> {
  const token = intentId.trim();
  if (
    token.length < 16 ||
    token.length > 255 ||
    !/^[A-Za-z0-9._:-]+$/.test(token)
  )
    throw new TypeError("A valid caller intent token is required.");
  return {
    idempotencyKey: `airtable:${scope.eventId}:${operation}:intent:${scope.personId ?? "anonymous"}:${token}`,
    operation,
    requestHash: await commandRequestHash(input),
  };
}

export class AirtableProviderBoundary {
  private readonly repository;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: AirtableProviderBoundaryDependencies = {},
  ) {
    this.repository =
      dependencies.repository ?? new AirtableEventDataRepository(env);
  }

  private async provider(scope: EventScope) {
    const event = await this.env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(scope.eventId, scope.organisationId)
      .first<{ repositoryProvider: string }>();
    if (!event)
      throw new AirtableEventScopeError(
        "Event not found in the authorised organisation.",
      );
    if (
      event.repositoryProvider !== "d1" &&
      event.repositoryProvider !== "airtable"
    )
      throw new Error("The event repository provider is invalid.");
    return event.repositoryProvider;
  }

  async assertReadable(
    scope: EventScope,
  ): Promise<AirtableEventDataSnapshot["freshness"] | null> {
    if ((await this.provider(scope)) === "d1") return null;
    const state = await this.repository.assertSynchronized(
      scope.organisationId,
      scope.eventId,
    );
    const rooms = await this.repository.assertRoomProjectionSynchronized(
      scope.organisationId,
      scope.eventId,
    );
    return {
      ...state.airtable.freshness,
      fetchedAt: Math.min(state.airtable.freshness.fetchedAt, rooms.fetchedAt),
      cacheExpiresAt: Math.min(
        state.airtable.freshness.cacheExpiresAt ?? rooms.cacheExpiresAt,
        rooms.cacheExpiresAt,
      ),
      cached: state.airtable.freshness.cached && rooms.cached,
    };
  }

  /**
   * Runs a Program Cue copy command behind the Airtable authority checkpoint.
   * A successful replay returns the bounded result stored with the projection
   * run and never invokes the domain command again.
   */
  async executeIdempotent<T>(
    scope: CommandScope,
    input: {
      idempotencyKey: string;
      operation: string;
      requestHash?: string;
    },
    command: () => Promise<T>,
    options: AirtableCommandOptions = {},
  ): Promise<T> {
    if ((await this.provider(scope)) === "d1") return command();
    await this.repository.assertRoomProjectionSynchronized(
      scope.organisationId,
      scope.eventId,
      { bypassCache: true },
    );
    const token = await this.repository.beginCommand(scope, {
      ...input,
      requestHash:
        input.requestHash ??
        (await commandRequestHash({
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
        })),
    });
    if (token.replayed) return replayCommandResult<T>(token.commandResult);
    let result: T;
    try {
      result = await command();
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "committed" in error &&
        error.committed === true
      ) {
        await this.repository.completeCommand(
          token,
          committedErrorResult(error),
        );
        throw error;
      }
      await this.repository.abortCommand(token, error);
      throw error;
    }
    let commandResult: AirtableProjectionCommandResult;
    if (options.replay === "reject") {
      commandResult = { kind: "unavailable", reason: "sensitive" };
    } else {
      try {
        commandResult = serializeCommandResult(result);
      } catch (error) {
        return this.repository.failCommandResult(token, error);
      }
    }
    await this.repository.completeCommand(token, commandResult);
    return options.replay === "reject"
      ? result
      : replayCommandResult<T>(commandResult);
  }

  recover(scope: CommandScope, runId: string) {
    return this.repository.recoverCommand(scope, runId);
  }
}
