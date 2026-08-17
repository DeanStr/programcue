import type { CSSProperties } from "react";
import { data } from "react-router";
import {
  PublicEventFooter,
  PublicEventHeader,
} from "~/components/public-event-chrome";
import { PublicSitePageContent } from "~/components/public-site-content";
import { restrictedMarkdownPlainText } from "~/components/restricted-markdown";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSitePageType,
} from "~/modules/public-site/public-site";
import { publishedSocialCardRevision } from "~/modules/public-site/public-site-presentation";
import { getValidatedPublishedPublicSite } from "~/modules/public-site/validated-public-site.server";
import {
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
} from "~/platform/api/api-public-programme.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/public-site-page";

function parsePage(value: string | undefined): PublicSitePageType {
  if (!PUBLIC_SITE_PAGE_TYPES.includes(value as PublicSitePageType))
    throw new Response("Public event page not found", { status: 404 });
  return value as PublicSitePageType;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const slug = params.slug ?? "";
  const page = parsePage(params.page);
  const { env } = getCloudflareContext(context);
  const publishedVersion = await new PublicProgrammeService(
    env,
  ).findPublishedVersion(slug);
  const site = await getValidatedPublishedPublicSite(
    env,
    slug,
    undefined,
    undefined,
    publishedVersion,
  );
  if (!site?.configuration.pages[page].enabled)
    throw new Response("Public event page not found", { status: 404 });
  const programmeRevision = publishedVersion
    ? `${publishedVersion.version.id}:${publishedVersion.version.versionNumber}:${publishedVersion.version.publishedAt}`
    : "none";
  const canonicalUrl = new URL(
    `/public/programme/${encodeURIComponent(site.event.slug)}/pages/${encodeURIComponent(page)}`,
    request.url,
  ).toString();
  const socialCardUrl = new URL(
    `/public/programme/${encodeURIComponent(site.event.slug)}/social-card.webp`,
    request.url,
  );
  socialCardUrl.searchParams.set(
    "v",
    publishedSocialCardRevision({
      siteContentRevision: site.contentRevision,
      siteRevision: site.revision,
    }),
  );
  const cacheHeaders = await publishedProgrammeCacheHeaders(
    request,
    site,
    `public-site-${site.contentRevision}-${site.revision}-${programmeRevision}`,
  );
  if (publishedProgrammeNotModified(request, cacheHeaders.etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  const { recordings: _recordings, ...fixedPageSite } = site;
  return data(
    {
      hasPublishedProgramme: publishedVersion !== null,
      programmeVersion: publishedVersion?.version ?? null,
      site: fixedPageSite,
      page,
      canonicalUrl,
      socialCardUrl: socialCardUrl.toString(),
    },
    { headers: cacheHeaders },
  );
}

export function headers({ loaderHeaders, errorHeaders }: Route.HeadersArgs) {
  return errorHeaders ?? loaderHeaders;
}

export const meta: Route.MetaFunction = ({ loaderData }) => {
  if (!loaderData) return [{ title: "Event page" }];
  const page = loaderData.site.configuration.pages[loaderData.page];
  const description =
    restrictedMarkdownPlainText(page.body).slice(0, 220) ||
    loaderData.site.event.description ||
    page.title;
  return [
    { title: `${page.title} · ${loaderData.site.event.name}` },
    {
      name: "description",
      content: description,
    },
    { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
    { property: "og:type", content: "website" },
    {
      property: "og:title",
      content: `${page.title} · ${loaderData.site.event.name}`,
    },
    { property: "og:description", content: description },
    { property: "og:image", content: loaderData.socialCardUrl },
    { property: "og:url", content: loaderData.canonicalUrl },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: loaderData.socialCardUrl },
  ];
};

export default function PublicSitePage(props: Route.ComponentProps) {
  const { hasPublishedProgramme, programmeVersion, site, page } =
    props.loaderData;
  const palette = programmeAccentPalette(site.event.brandAccent);
  return (
    <div
      className="public-shell event-branded public-site-page-shell"
      data-public-theme={site.configuration.theme}
      style={
        {
          "--event-accent": palette.accent,
          "--event-accent-light-ink": palette.ink,
          "--event-accent-on-solid": palette.onAccent,
        } as CSSProperties
      }
    >
      <PublicEventHeader
        event={site.event}
        programme={null}
        hasPublishedProgramme={hasPublishedProgramme}
        site={site.configuration}
        activePage={page}
      />
      <main id="main" className="public-site-page">
        <p className="pc-page-eyebrow">{site.event.name}</p>
        <h1>{site.configuration.pages[page].title}</h1>
        <PublicSitePageContent
          event={site.event}
          configuration={site.configuration}
          page={page}
        />
      </main>
      <PublicEventFooter
        event={site.event}
        programme={null}
        programmeVersion={programmeVersion}
      />
    </div>
  );
}
