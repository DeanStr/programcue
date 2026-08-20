import type { CSSProperties } from "react";
import {
  PublicEventFooter,
  PublicEventHeader,
} from "~/components/public-event-chrome";
import {
  type PublicProgrammeLoaderData,
  usePublicProgrammeModel,
} from "~/components/public-programme-model";
import { PublicProgrammeSurfaceContent } from "~/components/public-programme-surfaces";
import { PublicSiteHome } from "~/components/public-site-content";
import {
  programmeAccentCssVars,
  programmeAccentPalette,
} from "~/modules/programme/programme-presentation";
import {
  ItineraryPanel,
  ItineraryVerificationPrompt,
  OverviewSpeakers,
  ProgrammeSeamHeading,
  ProgrammeSessionList,
  PublicProgrammeFilters,
  PublicProgrammeHero,
  PublicProgrammeViewNavigation,
  SessionDetailPanel,
  VenuePanel,
} from "./public-programme-workspace-panels";

export { PublicSpeakerCard } from "./public-programme-workspace-panels";

export function PublicProgrammeWorkspace({
  loaderData: initialLoaderData,
}: {
  loaderData: PublicProgrammeLoaderData;
}) {
  const model = usePublicProgrammeModel(initialLoaderData);
  const { loaderData, programme, embedded, embedOptions, fetcher, shareUrl } =
    model;
  const overviewSurface =
    loaderData.surface === "overview" || loaderData.surface === "sessions";
  const homeSurface = loaderData.surface === "overview";
  const siblingSurface =
    loaderData.surface === "schedule" ||
    loaderData.surface === "timetable" ||
    loaderData.surface === "speakers" ||
    loaderData.surface === "gallery";
  const showHero = embedded || !siblingSurface;
  const homeConfiguration =
    homeSurface && loaderData.site ? loaderData.site.configuration : null;
  /* The curated homepage states the venue on a rail of its own. Leaving the
     sidebar card in place printed the same address twice on one page, under two
     headings, with two different words for the same map link. */
  const homeStatesVenue = Boolean(
    homeConfiguration?.sectionOrder.includes("venue") &&
      homeConfiguration.sectionVisibility.venue,
  );
  const accentPalette = programmeAccentPalette(
    embedOptions.accent ?? programme.event.brandAccent,
  );
  return (
    <div
      className={`public-shell event-branded${embedded ? " embedded" : ""}${embedded && embedOptions.density === "compact" ? " embed-compact" : ""}${siblingSurface ? " is-sibling" : ""}`}
      data-public-theme={
        embedded
          ? embedOptions.theme
          : (loaderData.site?.configuration.theme ?? "system")
      }
      style={programmeAccentCssVars(accentPalette) as CSSProperties}
    >
      {!embedded ? (
        <PublicEventHeader
          event={programme.event}
          programme={programme}
          site={loaderData.site?.configuration ?? null}
          activeSurface={loaderData.surface}
          itinerary={
            model.shared || model.saved.length
              ? { shared: model.shared, savedCount: model.saved.length }
              : undefined
          }
        />
      ) : null}
      <main
        aria-label={embedded ? "Embedded programme preview" : undefined}
        id="main"
        className="public-page-main"
        tabIndex={-1}
      >
        {showHero ? <PublicProgrammeHero model={model} /> : null}
        {!embedded && (!homeSurface || !loaderData.site) ? (
          <PublicProgrammeViewNavigation model={model} />
        ) : null}
        {homeSurface && loaderData.site ? (
          <>
            <PublicSiteHome
              event={programme.event}
              programme={programme}
              site={loaderData.site}
            />
            <ProgrammeSeamHeading />
          </>
        ) : null}
        <div
          className={`public-main${!overviewSurface ? " public-surface-main" : ""}${
            loaderData.surface === "speakers" ||
            loaderData.surface === "gallery"
              ? " is-cast"
              : ""
          }`}
        >
          {!overviewSurface ? (
            <div className="public-surface-content">
              <ItineraryVerificationPrompt model={model} />
              {embedded && embedOptions.controls.length ? (
                <PublicProgrammeFilters model={model} />
              ) : null}
              <PublicProgrammeSurfaceContent model={model} />
            </div>
          ) : (
            <>
              <div className="public-content">
                {fetcher.data && "error" in fetcher.data ? (
                  <div className="validation-item error mb" role="alert">
                    <strong>Itinerary not updated</strong>
                    <span>{String(fetcher.data.error)}</span>
                  </div>
                ) : null}
                {shareUrl ? (
                  <div className="public-share-notice mb" role="status">
                    <strong>Share link ready</strong>
                    <a href={shareUrl}>{shareUrl}</a>
                    <span>
                      The link is read-only. Creating another rotates it.
                    </span>
                  </div>
                ) : null}
                {embedOptions.controls.length || !embedded ? (
                  <PublicProgrammeFilters model={model} />
                ) : null}
                <ProgrammeSessionList model={model} />
              </div>
              {/* The rail precedes the roster in source order, so on a phone —
                where it stops being a rail — a tapped session's detail is the
                next thing under the list rather than 2,400px below it. */}
              <aside className="public-rail" id="itinerary">
                {!embedded && (model.shared || model.saved.length) ? (
                  <ItineraryPanel model={model} />
                ) : null}
                <SessionDetailPanel model={model} />
                {!embedded && !homeStatesVenue ? (
                  <VenuePanel model={model} />
                ) : null}
              </aside>
              <OverviewSpeakers model={model} />
            </>
          )}
        </div>
      </main>
      {!embedded ? (
        <PublicEventFooter event={programme.event} programme={programme} />
      ) : null}
    </div>
  );
}
