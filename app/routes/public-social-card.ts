import { requireValue } from "~/lib/required-value";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { PublishedPublicSiteInvariantError } from "~/modules/public-site/public-site-errors";
import {
  publishedPublicSiteInvariantResponse,
  publishedSocialCardRevision,
} from "~/modules/public-site/public-site-presentation";
import {
  publishedSocialCardAccent,
  socialCardSvg,
} from "~/modules/public-site/social-card-image";
import { rasterizeSocialCardSvg } from "~/modules/public-site/social-card-rasterizer.server";
import { getValidatedPublishedPublicSite } from "~/modules/public-site/validated-public-site.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/public-social-card";

export { publishedSocialCardAccent };

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.IMAGES)
    throw new Response("Social card generation is temporarily unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const slug = params.slug ?? "";
  const searchParams = new URL(request.url).searchParams;
  for (const name of new Set(searchParams.keys())) {
    if (
      (name !== "speaker" && name !== "v") ||
      searchParams.getAll(name).length !== 1
    )
      throw new Response("Unsupported social-card parameter", { status: 400 });
  }
  const speakerId = searchParams.get("speaker");
  const programme = speakerId
    ? await new PublicProgrammeService(env).getPublished(slug)
    : null;
  const site = await getValidatedPublishedPublicSite(env, slug, programme);
  if (!site)
    throw new Response("Published public event site not found", {
      status: 404,
    });
  const requestedVersion = searchParams.get("v");
  const currentVersion = publishedSocialCardRevision({
    siteContentRevision: site.contentRevision,
    siteRevision: site.revision,
    programmeContentRevision: programme?.contentRevision,
    speakerId,
  });
  if (requestedVersion !== null && requestedVersion !== currentVersion)
    throw new Response("Social-card revision not found", { status: 404 });
  const speaker =
    speakerId && programme
      ? programme.speakers.find((candidate) => candidate.id === speakerId)
      : null;
  if (speakerId && !speaker)
    throw new Response("Published speaker not found", { status: 404 });
  const session =
    speaker && programme
      ? programme.sessions.find((candidate) =>
          speaker.sessionIds.includes(candidate.id),
        )
      : null;
  if (speaker && !session)
    throw new Response(
      "The published speaker is not linked to a published session.",
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  const title = speaker
    ? `${speaker.displayName} is speaking`
    : site.event.name;
  const subtitle = speaker
    ? requireValue(session, "Required session is unavailable.").title
    : site.configuration.tagline || site.event.description || "Public event";
  const place = [site.event.venue, site.event.city].filter(Boolean).join(" · ");
  const eventContext = [
    site.event.startDate === site.event.endDate
      ? site.event.startDate
      : `${site.event.startDate} – ${site.event.endDate}`,
    place,
  ]
    .filter(Boolean)
    .join(" · ");
  let svg: string;
  try {
    svg = socialCardSvg({
      title,
      subtitle,
      eyebrow: speaker ? site.event.name : eventContext,
      footer: speaker ? "PUBLIC EVENT PROGRAMME" : "PUBLIC EVENT",
      accent: site.event.brandAccent,
    });
  } catch (error) {
    if (error instanceof PublishedPublicSiteInvariantError)
      throw publishedPublicSiteInvariantResponse();
    throw error;
  }
  try {
    const rasterized = await rasterizeSocialCardSvg(svg);
    const rendered = await env.IMAGES.input(
      new Blob([rasterized.png], { type: "image/png" }).stream(),
    ).output({ format: "image/webp", quality: 90, anim: false });
    if (rendered.contentType() !== "image/webp")
      throw new Error("Image rendering returned an unexpected content type.");
    return new Response(rendered.image(), {
      headers: {
        "content-type": "image/webp",
        "cache-control": requestedVersion
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300, stale-while-revalidate=3600",
        "content-disposition": `inline; filename="${speaker ? "speaker" : "event"}-social-card.webp"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Public social-card rendering failed", error);
    throw new Response("The social card could not be rendered.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
