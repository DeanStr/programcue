import { data } from "react-router";
import { ZodError } from "zod";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-person-search";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
  try {
    const matches = await new PersonDuplicateService(
      env,
    ).searchOrganisationPeople(viewer, query);
    return { query, matches };
  } catch (error) {
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
