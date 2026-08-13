import { data, Form, redirect, useLoaderData, useNavigation } from "react-router";

import type { Route } from "./+types/communication-unsubscribe";
import { BrandMark } from "~/components/brand-mark";
import type { CommunicationCategory } from "~/modules/communications/communication-schema";
import {
  describeCommunicationUnsubscribe,
  InvalidUnsubscribeTokenError,
  unsubscribeFromOptionalCommunication,
  UnsubscribeConfigurationError,
} from "~/modules/communications/unsubscribe.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const categoryLabels: Record<CommunicationCategory, string> = {
  submission_confirmation: "submission confirmations",
  decision: "decision updates",
  task_reminder: "task reminders",
  schedule: "schedule updates",
  calendar: "calendar updates",
  ad_hoc: "event updates",
};

export const meta: Route.MetaFunction = () => [
  { title: "Email preferences · Program Cue" },
  { name: "robots", content: "noindex, nofollow" },
];

function tokenFrom(params: Route.LoaderArgs["params"] | Route.ActionArgs["params"]) {
  if (!params.token) throw new Response("This unsubscribe link is invalid or has expired.", { status: 404 });
  return params.token;
}

function unsubscribeError(error: unknown): never {
  if (error instanceof InvalidUnsubscribeTokenError) {
    throw new Response(error.message, { status: 404 });
  }
  if (error instanceof UnsubscribeConfigurationError) {
    throw new Response("Email preferences are temporarily unavailable because secure token verification is not configured.", { status: 503 });
  }
  throw error;
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  try {
    return data(await describeCommunicationUnsubscribe(env, tokenFrom(params)), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    unsubscribeError(error);
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  const { env } = getCloudflareContext(context);
  try {
    const token = tokenFrom(params);
    await unsubscribeFromOptionalCommunication(env, token);
    return redirect(`/communications/unsubscribe/${encodeURIComponent(token)}`, 303);
  } catch (error) {
    unsubscribeError(error);
  }
}

export default function CommunicationUnsubscribe() {
  const preference = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  return (
    <main className="design-board" id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <section className="card pad" style={{ width: "min(520px, calc(100vw - 32px))" }}>
        <div className="brand" style={{ color: "var(--ink)", padding: 0 }}>
          <BrandMark /><span>Program Cue</span>
        </div>
        <p className="pc-page-eyebrow mt">{preference.eventName}</p>
        <h1>Email preferences</h1>
        {preference.isUnsubscribed ? (
          <div className="validation-item ok" role="status">
            <strong>✓</strong>
            <span><strong>{preference.address}</strong> is unsubscribed from optional {categoryLabels[preference.category]}.</span>
          </div>
        ) : (
          <>
            <p>Stop optional {categoryLabels[preference.category]} from being sent to <strong>{preference.address}</strong>?</p>
            <p className="subtle">Required transactional messages can still be sent when they are necessary to operate the event.</p>
            <Form method="post">
              <button className="btn primary mt" type="submit" disabled={submitting}>
                {submitting ? "Updating…" : "Unsubscribe"}
              </button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}
