import { data } from "react-router";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { resetProductionEvaluationFixture } from "~/platform/evaluation/evaluation-fixture.server";
import { requireEvaluationFixtureAccess } from "~/platform/evaluation/evaluation-fixture-access.server";
import {
  RequestBodyTooLargeError,
  readBoundedText,
} from "~/platform/http/read-body";
import type { Route } from "./+types/api-internal-evaluation-fixture-reset";

const MAXIMUM_REQUEST_BYTES = 4_096;

export function loader() {
  throw new Response("Not found", { status: 404 });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await requireEvaluationFixtureAccess(request, env.EVALUATION_FIXTURE_SECRET);
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return data(
      { error: "Content-Type must be application/json." },
      { status: 415, headers: { "cache-control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(request, MAXIMUM_REQUEST_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return data(
        { error: "The request body is too large." },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
    return data(
      { error: "The request body must be valid JSON." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const confirmation =
    body && typeof body === "object" && "confirmation" in body
      ? (body as { confirmation: unknown }).confirmation
      : undefined;
  const result = await resetProductionEvaluationFixture(env, confirmation);
  return data(result, { headers: { "cache-control": "no-store" } });
}
