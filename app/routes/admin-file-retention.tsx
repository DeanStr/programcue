import { data, Form, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/admin-file-retention";
import {
  FileAccessError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  FileService,
} from "~/modules/files/file-service.server";
import {
  ParticipantRetentionAccessError,
  ParticipantRetentionConfirmationError,
  ParticipantRetentionService,
  ParticipantRetentionStateError,
} from "~/modules/privacy/participant-retention-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Data retention · Program Cue" }];

export function assetCountLabel(count: number) {
  return `${count} asset${count === 1 ? "" : "s"}`;
}

async function owner(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, ["owner"]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await owner(request, context);
  const [state, participantRetention] = await Promise.all([
    new FileService(env).getFileRetentionState(viewer),
    new ParticipantRetentionService(env).preview(viewer),
  ]);
  return {
    state,
    participantRetention,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await owner(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new FileService(env);
  try {
    if (intent === "place-hold" || intent === "release-hold") {
      const state = await service.setFileRetentionHold(viewer, {
        hold: intent === "place-hold",
        confirmed: form.get("confirm") === "yes",
        reason: String(form.get("reason") ?? ""),
      });
      return data({
        ok: true,
        message: state.holdAt
          ? "File-retention erasure is now on hold."
          : "The file-retention hold was released.",
      });
    }
    if (intent === "erase-expired") {
      const state = await service.getFileRetentionState(viewer);
      const result = await service.eraseExpiredEventFiles(viewer, {
        confirmed: form.get("confirmation") === state.name,
        limit: 50,
      });
      return data({
        ok: true,
        message: `${result.erasedAssets} file asset${result.erasedAssets === 1 ? "" : "s"} and ${result.erasedVersions} stored version${result.erasedVersions === 1 ? "" : "s"} erased.${result.remainingAssets ? ` ${result.remainingAssets} assets remain; run the next confirmed batch.` : " Retention erasure is complete."}`,
      });
    }
    if (intent === "anonymise-participants") {
      const result = await new ParticipantRetentionService(
        env,
      ).anonymiseExpiredParticipants(viewer, {
        confirmation: String(form.get("confirmation") ?? ""),
        acknowledged: form.get("acknowledge") === "participant-retention",
        limit: 20,
      });
      if (!result.complete) {
        return data({
          ok: true,
          committed: true,
          message: `${result.state.anonymisedParticipants} participant identit${result.state.anonymisedParticipants === 1 ? "y has" : "ies have"} been anonymised. ${result.state.pendingParticipants} remain; review and confirm the next bounded batch.`,
        });
      }
      return data({
        ok: true,
        committed: true,
        message: result.duplicate
          ? "Local participant anonymisation was already complete."
          : `Local participant anonymisation is complete for ${result.state.anonymisedParticipants} identit${result.state.anonymisedParticipants === 1 ? "y" : "ies"}. Immutable audit evidence and separately controlled provider records remain as disclosed below.`,
      });
    }
    return data(
      { ok: false, message: "Unsupported data-retention action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof FileErasureIncompleteError) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "file-retention",
          event: "erasure-incomplete",
          errorName: error.name,
          message: "The bounded file-retention erasure did not complete.",
        }),
      );
      return data(
        { ok: false, committed: true, message: error.message },
        { status: 503 },
      );
    }
    if (
      error instanceof FileAccessError ||
      error instanceof FileErasureConfirmationError ||
      error instanceof FileRetentionStateError ||
      error instanceof ParticipantRetentionAccessError ||
      error instanceof ParticipantRetentionConfirmationError ||
      error instanceof ParticipantRetentionStateError
    ) {
      return data(
        { ok: false, message: error.message },
        {
          status:
            error instanceof FileAccessError ||
            error instanceof ParticipantRetentionAccessError
              ? 403
              : error instanceof FileErasureConfirmationError ||
                  error instanceof ParticipantRetentionConfirmationError
                ? 422
                : 409,
        },
      );
    }
    throw error;
  }
}

function dateTime(value: number | null) {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value * 1_000));
}

export default function AdminFileRetention({
  loaderData,
}: Route.ComponentProps) {
  const { state, participantRetention } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const participantIntegrityFailed =
    participantRetention.integrityViolations.length > 0;
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Privacy operations</span>
          <h1>Data retention</h1>
          <p>
            Permanently erase private files and anonymise participant data after
            the configured event retention period, or stop both workflows under
            a legal or operational hold.
          </p>
        </div>
      </div>
      {result ? (
        <div
          className={`validation-item ${result.ok ? "ok" : "error"} mb`}
          role={result.ok ? "status" : "alert"}
        >
          {result.message}
        </div>
      ) : null}
      <div className="grid grid-3 mb">
        <section className="card metric">
          <div className="label">Retention</div>
          <div className="value">{state.retentionMonths} months</div>
        </section>
        <section className="card metric">
          <div className="label">Eligible from</div>
          <div className="value" style={{ fontSize: "1.05rem" }}>
            {dateTime(state.eligibleAt)}
          </div>
        </section>
        <section className="card metric">
          <div className="label">Private versions remaining</div>
          <div className="value">{state.pendingVersionCount}</div>
        </section>
      </div>
      <div className="grid grid-2">
        <section className="card pad">
          <div className="card-title">
            <h2>Retention hold</h2>
            <span className={`status ${state.holdAt ? "warning" : "success"}`}>
              {state.holdAt ? "On hold" : "No hold"}
            </span>
          </div>
          <p className="subtle">
            {state.holdAt
              ? `Placed ${dateTime(state.holdAt)}. No retention batch can erase files or anonymise participant data until an owner releases it.`
              : "A hold immediately blocks file erasure and participant anonymisation for this event."}
          </p>
          <Form method="post" className="stack">
            <input
              type="hidden"
              name="intent"
              value={state.holdAt ? "release-hold" : "place-hold"}
            />
            <label className="label">
              Reason
              <textarea
                className="textarea"
                name="reason"
                minLength={3}
                maxLength={500}
                required
              />
            </label>
            <label className="speaker-confirm">
              <input type="checkbox" name="confirm" value="yes" required /> I
              understand this changes the event-wide retention boundary.
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {state.holdAt ? "Release retention hold" : "Place retention hold"}
            </button>
          </Form>
        </section>
        <section className="card pad">
          <div className="card-title">
            <h2>Erase expired files</h2>
            <span className={`status ${state.eligible ? "danger" : "info"}`}>
              {state.eligible ? "Eligible" : "Not yet eligible"}
            </span>
          </div>
          <p>
            This permanently removes up to 50 assets per confirmed batch,
            including every stored version. It currently affects{" "}
            <strong>{assetCountLabel(state.pendingAssetCount)}</strong>.
          </p>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="erase-expired" />
            <label className="label">
              Type <strong>{state.name}</strong> to confirm
              <input
                className="field"
                name="confirmation"
                autoComplete="off"
                required
              />
            </label>
            <button
              className="btn danger"
              type="submit"
              disabled={
                busy ||
                !state.eligible ||
                state.holdAt !== null ||
                state.pendingAssetCount === 0
              }
            >
              Permanently erase next batch
            </button>
          </Form>
        </section>
      </div>
      <section className="card pad mt">
        <div className="card-title">
          <div>
            <h2>Anonymise expired participant data</h2>
            <p className="subtle">
              Revoke event access and event-scoped sessions, replace participant
              links with pseudonyms, and redact stored submissions, reviews,
              delivery snapshots, provider identifiers and file metadata.
            </p>
          </div>
          <span
            className={`status ${participantIntegrityFailed ? "danger" : participantRetention.completed ? "success" : participantRetention.canRun ? "danger" : "warning"}`}
          >
            {participantIntegrityFailed
              ? "Integrity check failed"
              : participantRetention.completed
                ? "Local anonymisation complete"
                : participantRetention.canRun
                  ? "Ready for confirmation"
                  : "Blocked"}
          </span>
        </div>
        <div className="grid grid-3 mb">
          <div className="metric">
            <div className="label">Participants remaining</div>
            <div className="value">
              {participantRetention.pendingParticipants}
            </div>
          </div>
          <div className="metric">
            <div className="label">Participants anonymised</div>
            <div className="value">
              {participantRetention.anonymisedParticipants}
            </div>
          </div>
          <div className="metric">
            <div className="label">Completed</div>
            <div className="value" style={{ fontSize: "1.05rem" }}>
              {dateTime(participantRetention.completedAt)}
            </div>
          </div>
        </div>
        {participantRetention.blockers.length > 0 ? (
          <div className="validation-item error mb" role="alert">
            <strong>Resolve these safety checks first:</strong>
            <ul>
              {participantRetention.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {participantIntegrityFailed ? (
          <div className="validation-item error mb" role="alert">
            <strong>
              The completed retention state is inconsistent. Do not treat this
              event as fully anonymised:
            </strong>
            <ul>
              {participantRetention.integrityViolations.map((violation) => (
                <li key={violation}>{violation}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="validation-item warning mb">
          <strong>Records retained or controlled elsewhere:</strong>
          <ul>
            <li>
              {participantRetention.immutableAuditRecords} immutable event audit
              record
              {participantRetention.immutableAuditRecords === 1 ? "" : "s"}{" "}
              retain actor links, entity identifiers, correlation identifiers
              and metadata to preserve the append-only audit trail.
            </li>
            <li>
              {participantRetention.sharedIdentityAuditLinks} audit actor link
              {participantRetention.sharedIdentityAuditLinks === 1
                ? ""
                : "s"}{" "}
              remain attached to identities shared with another event; all
              mutable links in this event are pseudonymised.
            </li>
            <li>
              {participantRetention.retainedProgrammeRecords} programme session
              {participantRetention.retainedProgrammeRecords === 1
                ? ""
                : "s"}{" "}
              retain titles, slugs, formats, durations and schedule facts;
              speaker identities and submission-derived descriptions are
              anonymised.
            </li>
            <li>
              Unscoped security stores (
              {participantRetention.unscopedStoresNotAutomaticallyRedacted.join(
                ", ",
              )}
              ) cannot be safely attributed to one event and are not altered.
            </li>
            {participantRetention.externalProviderErasureRequired ? (
              <li>
                Airtable, email, calendar or integration providers may retain
                separately governed records. This action redacts local provider
                identifiers but does not claim provider-side deletion.
              </li>
            ) : null}
          </ul>
        </div>
        {!participantRetention.completed ? (
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="anonymise-participants" />
            <label className="label">
              Type <strong>{participantRetention.name}</strong> to confirm
              <input
                className="field"
                name="confirmation"
                autoComplete="off"
                required
              />
            </label>
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="acknowledge"
                value="participant-retention"
                required
              />{" "}
              I understand this permanently removes local participant content
              while retaining the disclosed audit and external-provider records.
            </label>
            <button
              className="btn danger"
              type="submit"
              disabled={busy || !participantRetention.canRun}
            >
              Anonymise next participant batch
            </button>
          </Form>
        ) : null}
      </section>
    </>
  );
}
