import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  publicProgrammeSurfacePath,
  sortPublishedSpeakers,
} from "~/modules/programme/programme-presentation";
import { usePublicProgrammeEmbedResize } from "./public-programme-embed-resize";
import { usePublicProgrammeItineraryModel } from "./public-programme-itinerary-model";
import {
  formatDay,
  type PublicProgrammeLoaderData,
} from "./public-programme-model-helpers";
import { usePublicProgrammeFilters } from "./use-public-programme-filters";

export type { PublicProgrammeLoaderData } from "./public-programme-model-helpers";
export {
  descriptionSnippet,
  distinctSorted,
  eventHeroImagePath,
  formatDay,
  formatTime,
  groupSessionsByDay,
  initials,
  normaliseDescription,
  sessionSpeakerDetails,
  speakerAffiliation,
} from "./public-programme-model-helpers";

export function usePublicProgrammeModel(loaderData: PublicProgrammeLoaderData) {
  const { programme } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const embedded = loaderData.embedded;
  const shared = loaderData.shared;
  const embedOptions = loaderData.embedOptions;
  const itinerary = usePublicProgrammeItineraryModel(loaderData);
  const { fetcher, saved, shareUrl } = itinerary;
  const [expandedDescriptions, setExpandedDescriptions] = useState<string[]>(
    [],
  );
  const speakerById = useMemo(
    () =>
      new Map(
        programme.speakers.map((speaker) => [speaker.id, speaker] as const),
      ),
    [programme.speakers],
  );
  const orderedSpeakers = useMemo(
    () => sortPublishedSpeakers(programme.speakers),
    [programme.speakers],
  );
  const [selectedId, setSelectedId] = useState(
    loaderData.sessionFocusId ?? programme.sessions[0]?.id ?? "",
  );
  const [sessionFocusOverride, setSessionFocusOverride] = useState<
    string | null | undefined
  >(undefined);
  const {
    query,
    setQuery,
    standaloneDirectoryQuery,
    setStandaloneDirectoryQuery,
    standaloneGalleryQuery,
    setStandaloneGalleryQuery,
    days,
    day,
    setPublicDay,
    track,
    setTrack,
    format,
    setFormat,
    room,
    setRoom,
    tracks,
    formats,
    rooms,
    clearedSavedFilterNotice,
    publicSearchWithPendingQueries,
    pendingClientSearches,
    showControl,
    clearFilters,
  } = usePublicProgrammeFilters(loaderData, setSessionFocusOverride);
  const sessionDetailRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (embedded) return;
    setSelectedId(loaderData.sessionFocusId ?? programme.sessions[0]?.id ?? "");
  }, [embedded, loaderData.sessionFocusId, programme.sessions]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A loader focus change releases the local pending focus override.
  useEffect(() => {
    setSessionFocusOverride(undefined);
  }, [loaderData.sessionFocusId]);
  useEffect(() => {
    if (!loaderData.sessionFocusId || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    window.requestAnimationFrame(() => {
      sessionDetailRef.current?.focus({ preventScroll: true });
      sessionDetailRef.current?.scrollIntoView({ block: "start" });
    });
  }, [loaderData.sessionFocusId]);
  const [embeddedSelectedSpeakerId, setEmbeddedSelectedSpeakerId] =
    useState("");
  const selectedSpeakerId = embedded
    ? embeddedSelectedSpeakerId
    : (loaderData.speakerShare?.speakerId ?? "");
  const [expandedSpeakerBiography, setExpandedSpeakerBiography] =
    useState(false);
  const speakerProfileRef = useRef<HTMLElement | null>(null);
  const speakerProfileReturnFocusRef = useRef<HTMLElement | null>(null);
  const speakerProfileReturnSessionRef = useRef<string | null>(null);
  const visibleEmbedFields = new Set(embedOptions.fields);
  const showEmbedField = (field: (typeof embedOptions.fields)[number]) =>
    !embedded || visibleEmbedFields.has(field);
  const showSpeakerDirectory = !embedded || embedOptions.showSpeakerDirectory;
  const showSpeakerDetails = showEmbedField("speaker-details");
  usePublicProgrammeEmbedResize(embedded, programme.event.slug);
  const normalisedQuery = query.trim().toLocaleLowerCase();
  const sessionsMatchingFacets = useMemo(
    () =>
      programme.sessions.filter((session) => {
        const matchesDay =
          day === "All days" ||
          formatDay(session.startsAt, programme.event.timezone) === day;
        const matchesTrack = !track || session.track === track;
        const matchesFormat = !format || session.format === format;
        const matchesRoom = !room || session.room === room;
        return matchesDay && matchesTrack && matchesFormat && matchesRoom;
      }),
    [day, format, programme, room, track],
  );
  const visible = useMemo(
    () =>
      sessionsMatchingFacets.filter((session) =>
        [
          session.title,
          session.description,
          session.speakerNames.join(" "),
          session.track,
          session.format,
          session.room,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalisedQuery),
      ),
    [normalisedQuery, sessionsMatchingFacets],
  );
  const sessionFiltersActive =
    day !== "All days" || Boolean(track) || Boolean(format) || Boolean(room);
  const filtersActive = sessionFiltersActive || query.trim() !== "";
  const clearableFiltersActive =
    (showControl("search") && query.trim() !== "") ||
    (showControl("day") && day !== "All days") ||
    (showControl("track") && Boolean(track)) ||
    (showControl("format") && Boolean(format)) ||
    (showControl("room") && Boolean(room));
  const effectiveSessionFocusId =
    sessionFocusOverride === undefined
      ? loaderData.sessionFocusId
      : sessionFocusOverride;
  const focusedSession =
    effectiveSessionFocusId === null
      ? null
      : (programme.sessions.find(
          (session) => session.id === effectiveSessionFocusId,
        ) ?? null);
  const focusedSessionIsVisible =
    focusedSession !== null &&
    visible.some((session) => session.id === focusedSession.id);
  const selected = focusedSessionIsVisible
    ? focusedSession
    : (visible.find((session) => session.id === selectedId) ??
      visible[0] ??
      null);
  const visibleSessionIds = new Set(visible.map((session) => session.id));
  useEffect(() => {
    if (
      embedded ||
      sessionFocusOverride !== undefined ||
      loaderData.sessionFocusId === null ||
      focusedSessionIsVisible
    ) {
      return;
    }
    const search = new URLSearchParams(location.search);
    if (search.get("session") !== loaderData.sessionFocusId) return;
    search.delete("session");
    const nextSearch = search.size ? `?${search}` : "";
    setSessionFocusOverride(null);
    pendingClientSearches.current.add(nextSearch);
    void navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
        hash: location.hash,
      },
      { replace: true, preventScrollReset: true },
    );
  }, [
    embedded,
    loaderData.sessionFocusId,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    sessionFocusOverride,
    focusedSessionIsVisible,
    pendingClientSearches.current.add,
  ]);
  const facetSpeakerIds = new Set(
    sessionsMatchingFacets.flatMap((session) => session.speakerIds),
  );
  const visibleSpeakerIds = new Set(
    visible.flatMap((session) => session.speakerIds),
  );
  const visibleSpeakers = orderedSpeakers.filter((speaker) => {
    const matchesFacets =
      (!embedded && !sessionFiltersActive) || facetSpeakerIds.has(speaker.id);
    const matchesQuery =
      !normalisedQuery ||
      visibleSpeakerIds.has(speaker.id) ||
      [
        speaker.displayName,
        speaker.jobTitle,
        speaker.organisationName,
        speaker.biography,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalisedQuery);
    return matchesFacets && matchesQuery;
  });
  const directoryQuery = embedded ? query : standaloneDirectoryQuery;
  const setDirectoryQuery = embedded ? setQuery : setStandaloneDirectoryQuery;
  const galleryQuery = embedded ? query : standaloneGalleryQuery;
  const setGalleryQuery = embedded ? setQuery : setStandaloneGalleryQuery;
  const speakerSurfaceSource = embedded ? visibleSpeakers : orderedSpeakers;
  const directorySpeakers = useMemo(() => {
    const normalisedDirectoryQuery = embedded
      ? ""
      : standaloneDirectoryQuery.trim().toLocaleLowerCase();
    return speakerSurfaceSource.filter(
      (speaker) =>
        !normalisedDirectoryQuery ||
        speaker.displayName
          .toLocaleLowerCase()
          .includes(normalisedDirectoryQuery),
    );
  }, [embedded, speakerSurfaceSource, standaloneDirectoryQuery]);
  const gallerySpeakers = useMemo(() => {
    const normalisedGalleryQuery = embedded
      ? ""
      : standaloneGalleryQuery.trim().toLocaleLowerCase();
    return speakerSurfaceSource.filter(
      (speaker) =>
        !normalisedGalleryQuery ||
        speaker.displayName
          .toLocaleLowerCase()
          .includes(normalisedGalleryQuery),
    );
  }, [embedded, speakerSurfaceSource, standaloneGalleryQuery]);
  const selectedSpeaker = showSpeakerDetails
    ? (programme.speakers.find((speaker) => speaker.id === selectedSpeakerId) ??
      null)
    : null;
  const selectedSpeakerSessions = selectedSpeaker
    ? programme.sessions.filter(
        (session) =>
          selectedSpeaker.sessionIds.includes(session.id) &&
          visibleSessionIds.has(session.id),
      )
    : [];
  const selectedSpeakerAllSessions = selectedSpeaker
    ? programme.sessions.filter((session) =>
        selectedSpeaker.sessionIds.includes(session.id),
      )
    : [];
  const savedSessions = programme.sessions.filter((session) =>
    saved.includes(session.id),
  );
  const selectedConflicts = selected
    ? savedSessions.filter(
        (session) =>
          session.id !== selected.id &&
          session.startsAt < selected.endsAt &&
          selected.startsAt < session.endsAt,
      )
    : [];
  const itineraryConflicts = savedSessions.flatMap((session, index) =>
    savedSessions
      .slice(index + 1)
      .filter(
        (other) =>
          session.startsAt < other.endsAt && other.startsAt < session.endsAt,
      )
      .map((other) => [session.title, other.title] as const),
  );

  // Opening a speaker profile moves reading position to the panel; closing it
  // returns focus to the exact control that opened it.
  useEffect(() => {
    if (selectedSpeakerId) speakerProfileRef.current?.focus();
  }, [selectedSpeakerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Speaker selection is the deliberate reset trigger for expanded biography state.
  useEffect(() => {
    setExpandedSpeakerBiography(false);
  }, [selectedSpeakerId]);

  function openSpeakerProfile(speakerId: string, trigger: HTMLElement) {
    if (!showSpeakerDetails) return;
    speakerProfileReturnFocusRef.current = trigger;
    if (embedded) {
      setEmbeddedSelectedSpeakerId(speakerId);
      return;
    }
    const search = publicSearchWithPendingQueries();
    const sessionId = search.get("session");
    if (sessionId) speakerProfileReturnSessionRef.current = sessionId;
    search.delete("session");
    setSessionFocusOverride(null);
    search.set("speaker", speakerId);
    const nextSearch = `?${search}`;
    pendingClientSearches.current.add(nextSearch);
    void navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
        hash:
          loaderData.surface === "gallery"
            ? "#speaker-gallery-detail"
            : loaderData.surface === "speakers"
              ? "#public-speaker-detail"
              : "#programme-speaker-profile",
      },
      { preventScrollReset: true },
    );
  }

  function closeSpeakerProfile() {
    const returnFocus = speakerProfileReturnFocusRef.current;
    const findFocusTarget = () =>
      [
        returnFocus,
        selectedSpeakerId
          ? document.getElementById(`speaker-gallery-card-${selectedSpeakerId}`)
          : null,
        selectedSpeakerId
          ? document.getElementById(`public-speaker-card-${selectedSpeakerId}`)
          : null,
        selectedSpeakerId
          ? document.getElementById(`speaker-profile-link-${selectedSpeakerId}`)
          : null,
        document.getElementById("speaker-gallery-search"),
        document.getElementById("public-speaker-search"),
      ].find((element): element is HTMLElement =>
        Boolean(element?.isConnected),
      ) ?? null;
    if (embedded) {
      setEmbeddedSelectedSpeakerId("");
      speakerProfileReturnFocusRef.current = null;
      requestAnimationFrame(() => findFocusTarget()?.focus());
      return;
    }
    const search = publicSearchWithPendingQueries();
    search.delete("speaker");
    const returnSessionId = speakerProfileReturnSessionRef.current;
    if (returnSessionId) search.set("session", returnSessionId);
    const nextSearch = search.size ? `?${search}` : "";
    pendingClientSearches.current.add(nextSearch);
    speakerProfileReturnFocusRef.current = null;
    speakerProfileReturnSessionRef.current = null;
    void Promise.resolve(
      navigate(
        {
          pathname: location.pathname,
          search: nextSearch,
          hash: "",
        },
        { preventScrollReset: true },
      ),
    ).then(() => findFocusTarget()?.focus());
  }

  /**
   * Beside the list the detail panel is already in view, so selecting a row
   * must not move focus away from it. Stacked under the list it is a screen
   * away, and a selection that changed something off-screen read as a row that
   * did nothing at all on a phone.
   */
  function openSessionDetail(sessionId: string) {
    if (!embedded) setSessionFocusOverride(sessionId);
    setSelectedId(sessionId);
    if (!embedded) {
      const search = publicSearchWithPendingQueries();
      search.delete("speaker");
      search.set("session", sessionId);
      const nextSearch = `?${search}`;
      void navigate(
        {
          pathname: publicProgrammeSurfacePath(
            programme.event.slug,
            "sessions",
          ),
          search: nextSearch,
          hash: "",
        },
        { preventScrollReset: true },
      );
    }
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    window.requestAnimationFrame(() => {
      const panel = sessionDetailRef.current;
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });
  }

  function toggleDescription(sessionId: string) {
    setExpandedDescriptions((current) =>
      current.includes(sessionId)
        ? current.filter((value) => value !== sessionId)
        : [...current, sessionId],
    );
  }

  function toggleSpeakerBiography() {
    setExpandedSpeakerBiography((current) => !current);
  }

  function selectSavedSession(sessionId: string) {
    if (!visibleSessionIds.has(sessionId)) clearFilters();
    else setSessionFocusOverride(null);
    setSelectedId(sessionId);
  }

  return {
    loaderData,
    surface: loaderData.surface,
    programme,
    embedded,
    shared,
    embedOptions,
    fetcher,
    turnstileToken: itinerary.turnstileToken,
    updateTurnstileToken: itinerary.updateTurnstileToken,
    turnstileResetKey: itinerary.turnstileResetKey,
    itineraryVerificationPrompted: itinerary.itineraryVerificationPrompted,
    itineraryVerificationRef: itinerary.itineraryVerificationRef,
    shareUrl,
    saved,
    query,
    setQuery,
    directoryQuery,
    setDirectoryQuery,
    directorySpeakers,
    galleryQuery,
    setGalleryQuery,
    gallerySpeakers,
    days,
    day,
    setDay: setPublicDay,
    track,
    setTrack,
    format,
    setFormat,
    room,
    setRoom,
    expandedDescriptions,
    tracks,
    formats,
    rooms,
    speakerById,
    orderedSpeakers,
    selectedId,
    setSelectedId,
    sessionDetailRef,
    openSessionDetail,
    speakerProfileRef,
    showControl,
    showEmbedField,
    showSpeakerDirectory,
    showSpeakerDetails,
    visible,
    filtersActive,
    clearableFiltersActive,
    clearedSavedFilterNotice,
    selected,
    visibleSpeakers,
    selectedSpeaker,
    selectedSpeakerSessions,
    selectedSpeakerAllSessions,
    speakerShare: loaderData.speakerShare,
    expandedSpeakerBiography,
    savedSessions,
    itineraryConflicts,
    selectedConflicts,
    openSpeakerProfile,
    closeSpeakerProfile,
    toggleDescription,
    toggleSpeakerBiography,
    clearFilters,
    selectSavedSession,
    requiresItineraryVerification: itinerary.requiresItineraryVerification,
    toggle: itinerary.toggle,
  };
}

export type PublicProgrammeModel = ReturnType<typeof usePublicProgrammeModel>;
