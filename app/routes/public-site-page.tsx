import { ExternalLink, MapPin } from "lucide-react";
import type { CSSProperties } from "react";
import { data } from "react-router";
import {
  PublicEventFooter,
  PublicEventHeader,
} from "~/components/public-event-chrome";
import {
  RestrictedMarkdown,
  restrictedMarkdownPlainText,
} from "~/components/restricted-markdown";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSitePageType,
} from "~/modules/public-site/public-site";
import { publicVenueLabel } from "~/modules/public-site/public-site-presentation";
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
  const programme = await new PublicProgrammeService(env).getPublished(slug);
  const site = await getValidatedPublishedPublicSite(env, slug, programme);
  if (!site?.configuration.pages[page].enabled)
    throw new Response("Public event page not found", { status: 404 });
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
    programme
      ? `${programme.contentRevision}-${site.contentRevision}-${site.revision}`
      : `${site.contentRevision}-${site.revision}`,
  );
  const cacheHeaders = await publishedProgrammeCacheHeaders(
    request,
    programme ?? site,
    `public-site-${site.contentRevision}-${site.revision}`,
  );
  if (publishedProgrammeNotModified(request, cacheHeaders.etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return data(
    {
      programme,
      site,
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

function PageBody({ loaderData }: Route.ComponentProps) {
  const { site, page } = loaderData;
  const configuration = site.configuration.pages[page];
  if (page === "faq") {
    return (
      <>
        {configuration.body ? (
          <RestrictedMarkdown>{configuration.body}</RestrictedMarkdown>
        ) : null}
        <div className="public-site-faq">
          {site.configuration.faqItems.map((item) => (
            <details key={item.id}>
              <summary>{item.question}</summary>
              <RestrictedMarkdown>{item.answer}</RestrictedMarkdown>
            </details>
          ))}
        </div>
      </>
    );
  }
  if (page === "venue") {
    return (
      <>
        {configuration.body ? (
          <RestrictedMarkdown>{configuration.body}</RestrictedMarkdown>
        ) : null}
        <div className="public-site-venue">
          <MapPin aria-hidden />
          <div>
            {publicVenueLabel(site.event) !==
            site.event.venueAddress?.trim() ? (
              <strong>{publicVenueLabel(site.event)}</strong>
            ) : null}
            {site.event.venueAddress ? (
              <address>{site.event.venueAddress}</address>
            ) : null}
            {site.event.venueMapUrl ? (
              <a href={site.event.venueMapUrl} rel="noreferrer">
                Open map <ExternalLink aria-hidden size={13} />
              </a>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  if (page === "sponsors") {
    const tiers = new Map<string, typeof site.configuration.sponsors>();
    for (const sponsor of site.configuration.sponsors) {
      tiers.set(sponsor.tier, [...(tiers.get(sponsor.tier) ?? []), sponsor]);
    }
    return (
      <>
        {configuration.body ? (
          <RestrictedMarkdown>{configuration.body}</RestrictedMarkdown>
        ) : null}
        {[...tiers.entries()].map(([tier, sponsors]) => (
          <section className="public-site-sponsor-tier" key={tier}>
            <h2>{tier}</h2>
            <div className="public-site-sponsor-grid">
              {sponsors.map((sponsor) => (
                <div className="public-site-sponsor-card" key={sponsor.id}>
                  {sponsor.logoUrl ? (
                    <img
                      src={sponsor.logoUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  <strong>{sponsor.name}</strong>
                  {sponsor.description ? (
                    <small>{sponsor.description}</small>
                  ) : null}
                  {sponsor.websiteUrl ? (
                    <a href={sponsor.websiteUrl} rel="noreferrer">
                      Visit sponsor <ExternalLink aria-hidden size={13} />
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }
  const body =
    configuration.body ||
    (page === "about" ? (site.event.description ?? "") : "");
  return <RestrictedMarkdown>{body}</RestrictedMarkdown>;
}

export default function PublicSitePage(props: Route.ComponentProps) {
  const { programme, site, page } = props.loaderData;
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
        programme={programme}
        site={site.configuration}
        activePage={page}
      />
      <main id="main" className="public-site-page">
        <p className="pc-page-eyebrow">{site.event.name}</p>
        <h1>{site.configuration.pages[page].title}</h1>
        <PageBody {...props} />
      </main>
      <PublicEventFooter event={site.event} programme={programme} />
    </div>
  );
}
