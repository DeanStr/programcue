import { data, Form } from "react-router";
import { BrandMark } from "~/components/brand-mark";
import {
  ScheduleReviewLinkService,
  scheduleReviewPreviewHeaders,
  scheduleReviewPreviewNotFound,
} from "~/modules/schedule/schedule-review-link-service.server";
import type { ScheduleReviewProjection } from "~/modules/schedule/schedule-review-projection";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  AbuseRateLimitError,
  enforcePublicRateLimit,
} from "~/platform/http/public-abuse-protection.server";
import type { Route } from "./+types/programme-preview";

export const headers: Route.HeadersFunction = () =>
  scheduleReviewPreviewHeaders();

export const meta: Route.MetaFunction = () => [
  { title: "Confidential programme preview" },
  { name: "robots", content: "noindex, nofollow" },
  { name: "referrer", content: "no-referrer" },
];

function previewService(env: CloudflareEnvironment) {
  const schedule = new ScheduleService(env);
  return new ScheduleReviewLinkService(env, {
    getWorkspace: (viewer) => schedule.getWorkspace(viewer),
  });
}

async function protectPreview(request: Request, env: CloudflareEnvironment) {
  try {
    await enforcePublicRateLimit({
      env,
      request,
      action: "programme_preview",
      tenantId: "programme-preview",
      email: "",
    });
  } catch (error) {
    if (error instanceof AbuseRateLimitError) {
      throw new Response(error.message, {
        status: 429,
        headers: {
          ...scheduleReviewPreviewHeaders(),
          "retry-after": String(error.retryAfterSeconds),
        },
      });
    }
    throw error;
  }
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await protectPreview(request, env);
  const token = params.token ?? "";
  const live = await previewService(env).readLivePreview(token);
  if (!live) scheduleReviewPreviewNotFound();
  return data(
    { kind: "notice" as const },
    { headers: scheduleReviewPreviewHeaders() },
  );
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    throw new Response("Method not allowed.", {
      status: 405,
      headers: {
        allow: "GET, HEAD, POST",
        ...scheduleReviewPreviewHeaders(),
      },
    });
  }
  const { env } = getCloudflareContext(context);
  await protectPreview(request, env);
  const projection = await previewService(env).loadPreviewProjection(
    params.token ?? "",
  );
  if (!projection) scheduleReviewPreviewNotFound();
  return data(
    { kind: "snapshot" as const, projection },
    { headers: scheduleReviewPreviewHeaders() },
  );
}

function clockLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function dayHeading(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function SnapshotView({
  projection,
}: {
  projection: ScheduleReviewProjection;
}) {
  const days: Array<{
    key: string;
    heading: string;
    entries: ScheduleReviewProjection["entries"];
  }> = [];
  for (const entry of projection.entries) {
    const key = eventLocalCalendarDate(
      entry.startsAt,
      projection.event.timezone,
    );
    const existing = days.find((day) => day.key === key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    days.push({
      key,
      heading: dayHeading(entry.startsAt, projection.event.timezone),
      entries: [entry],
    });
  }
  return (
    <main
      className="design-board programme-preview-page"
      id="main"
      tabIndex={-1}
    >
      <section className="card pad programme-preview-shell">
        <BrandMark />
        <p className="eyebrow">Confidential draft preview</p>
        <h1>{projection.event.name}</h1>
        <p className="subtle">
          Times are shown in {projection.event.timezone}. This is a frozen
          unpublished snapshot, not the live programme.
        </p>
        {days.length === 0 ? (
          <p className="programme-preview-empty">
            This snapshot has no scheduled public sessions.
          </p>
        ) : (
          days.map((day) => (
            <section key={day.key} className="programme-preview-day">
              <h2>{day.heading}</h2>
              <ol className="programme-preview-list">
                {day.entries.map((entry, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Frozen snapshot rows have no stored identity; duplicate visible fields are valid.
                  <li key={index} className="programme-preview-item">
                    <p className="programme-preview-when">
                      {clockLabel(entry.startsAt, projection.event.timezone)}–
                      {clockLabel(entry.endsAt, projection.event.timezone)}
                      {" · "}
                      {entry.room}
                    </p>
                    <h3>{entry.title}</h3>
                    <p className="subtle">
                      {entry.format}
                      {entry.track ? ` · ${entry.track}` : ""}
                    </p>
                    {entry.speakers.length ? (
                      <p>{entry.speakers.join(", ")}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
      </section>
    </main>
  );
}

export default function ProgrammePreview({ actionData }: Route.ComponentProps) {
  if (actionData && "projection" in actionData) {
    return <SnapshotView projection={actionData.projection} />;
  }
  return (
    <main
      className="design-board programme-preview-page"
      id="main"
      tabIndex={-1}
    >
      <section className="card pad programme-preview-shell">
        <BrandMark />
        <h1>Confidential programme preview</h1>
        <p className="subtle">
          This link is a secret. Continue only if you were given it to review an
          unpublished timetable.
        </p>
        <Form method="post" className="page-actions mt">
          <button className="btn primary" type="submit">
            View programme
          </button>
        </Form>
      </section>
    </main>
  );
}
