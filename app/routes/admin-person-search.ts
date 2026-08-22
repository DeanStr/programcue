import { data } from "react-router";
import { ZodError, z } from "zod";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EvaluatorEmailAliasContextError,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import type { Route } from "./+types/admin-person-search";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
  try {
    const email = z.email().safeParse(query);
    const resolvedQuery = email.success
      ? (await resolveEvaluatorEmailAlias(env, viewer, email.data)).email
      : query;
    const matches = await new PersonDuplicateService(
      env,
    ).searchOrganisationPeople(viewer, resolvedQuery);
    return { query, matches };
  } catch (error) {
    if (error instanceof EvaluatorEmailAliasContextError) {
      return data(
        { query, matches: [], error: error.message },
        { status: 422 },
      );
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      if (!issue) throw error;
      return data(
        { query, matches: [], error: issue.message },
        { status: 400 },
      );
    }
    throw error;
  }
}
