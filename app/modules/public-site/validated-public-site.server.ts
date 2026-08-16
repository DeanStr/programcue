import { ZodError } from "zod";

import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import { PublishedPublicSiteInvariantError } from "./public-site-errors";
import {
  publishedPublicSiteInvariantResponse,
  resolvePublicSitePresentation,
} from "./public-site-presentation";
import { PublicSiteService } from "./public-site-service.server";

export async function getValidatedPublishedPublicSite(
  env: CloudflareEnvironment,
  programme: PublishedProgramme,
  now?: number,
) {
  try {
    const site = await new PublicSiteService(env).getPublished(
      programme.event.slug,
      now,
    );
    if (site) resolvePublicSitePresentation(site.configuration, programme);
    return site;
  } catch (error) {
    if (
      error instanceof PublishedPublicSiteInvariantError ||
      error instanceof ZodError ||
      error instanceof SyntaxError
    ) {
      throw publishedPublicSiteInvariantResponse();
    }
    throw error;
  }
}
