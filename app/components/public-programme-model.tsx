import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";

import type { parseProgrammeEmbedSearchParameters } from "~/modules/programme/programme-embed-configuration";
import {
  type PublicProgrammeSurface,
  publicProgrammeSurfacePath,
  sortPublishedSpeakers,
} from "~/modules/programme/programme-presentation";
import {
  clearedPublicProgrammeFacetMessage,
  clearUnavailablePublicProgrammeFacets,
} from "~/modules/programme/public-programme-filter-state";
import type {
  PublishedProgramme,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import type { PublishedPublicSite } from "~/modules/public-site/public-site-service.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";

export type PublicProgrammeLoaderData = {
  programme: PublishedProgramme;
  surface: PublicProgrammeSurface;
  itinerary: string[];
  embedded: boolean;
  embedOptions: ReturnType<typeof parseProgrammeEmbedSearchParameters>;
  signedIn: boolean;
  itineraryVerificationRequired: boolean;
  turnstileSiteKey: string | null;
  itinerarySynced: boolean;
  shared: boolean;
  calendarExportQuery: string;
  canonicalUrl: string;
  speakerShare: {
    speakerId: string;
    speakerName: string;
    sessionTitle: string | null;
    description: string;
    url: string;
    text: string;
    imageUrl: string | null;
  } | null;
  sessionShare: {
    sessionId: string;
    sessionTitle: string;
    description: string;
    url: string;
  } | null;
  sessionFocusId: string | null;
  site?: PublishedPublicSite | null;
};

export function formatDay(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function formatTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

const DESCRIPTION_SNIPPET_LENGTH = 180;

export function descriptionSnippet(description: string) {
  const collapsed = normaliseDescription(description);
  if (collapsed.length <= DESCRIPTION_SNIPPET_LENGTH) return collapsed;
  const cut = collapsed.slice(0, DESCRIPTION_SNIPPET_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > DESCRIPTION_SNIPPET_LENGTH / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function normaliseDescription(description: string) {
  return description.replace(/\s+/gu, " ").trim();
}

/**
 * A managed published banner takes precedence over the retired external hero
 * URL. Any persisted non-null value that violates its contract is corrupt
 * configuration and must not be silently hidden.
 */
export function eventHeroImagePath(event: PublishedProgramme["event"]) {
  if (event.bannerUrl !== null) {
    if (!/^\/public\/brand\/[a-z0-9-]+\/banner$/u.test(event.bannerUrl))
      throw new Error("Published programme banner URL is invalid.");
    return event.bannerUrl;
  }
  const value = event.heroImageUrl;
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || value.length > 2_048) throw new Error();
    return url.href;
  } catch {
    throw new Error("Published programme hero image URL is invalid.");
  }
}

function firstGrapheme(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segment = new Intl.Segmenter("en", {
      granularity: "grapheme",
    }).segment(value);
    return [...segment][0]?.segment ?? "";
  }
  return [...value][0] ?? "";
}

function isEmojiGrapheme(value: string) {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

export function initials(name: string) {
  const letters = name
    .split(/\s+/u)
    .map((part) => firstGrapheme(part))
    .filter((part) => part && !isEmojiGrapheme(part));
  const fallback = firstGrapheme(name.trim());
  return (
    letters.slice(0, 2).join("") ||
    (fallback && !isEmojiGrapheme(fallback) ? fallback : "") ||
    "PC"
  );
}

/**
 * Consecutive sessions that share a calendar day become one group. The service
 * already orders by `starts_at`, so a running comparison preserves programme
 * order without re-sorting, and every list that renders sessions can show the
 * date once as a heading instead of repeating it on every row.
 */
export function groupSessionsByDay<T extends { startsAt: number }>(
  sessions: readonly T[],
  timezone: string,
) {
  const groups: Array<{ key: string; label: string; sessions: T[] }> = [];
  for (const session of sessions) {
    const key = eventLocalCalendarDate(session.startsAt, timezone);
    const current = groups.at(-1);
    if (current?.key === key) current.sessions.push(session);
    else
      groups.push({
        key,
        label: formatDay(session.startsAt, timezone),
        sessions: [session],
      });
  }
  return groups;
}

export function distinctSorted(values: Array<string | null>) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ].sort((left, right) => left.localeCompare(right));
}

export function speakerAffiliation(
  speaker: Pick<PublishedSpeaker, "jobTitle" | "organisationName">,
) {
  return [speaker.jobTitle?.trim(), speaker.organisationName?.trim()]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

export function sessionSpeakerDetails(
  session: PublishedProgramme["sessions"][number],
  speakerById: ReadonlyMap<string, PublishedSpeaker>,
) {
  return session.speakerIds.map((speakerId, index) => {
    const speaker = speakerById.get(speakerId);
    if (!speaker) {
      throw new Error(
        `Published session ${session.id} has no speaker ${speakerId}.`,
      );
    }
    const displayName = session.speakerNames[index];
    if (displayName !== speaker.displayName) {
      throw new Error(
        `Published session ${session.id} has a missing or stale name for speaker ${speakerId}.`,
      );
    }
    return {
      ...speaker,
      id: speakerId,
      displayName,
    };
  });
}

export function usePublicProgrammeModel(loaderData: PublicProgrammeLoaderData) {
  const { programme } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const embedded = loaderData.embedded;
  const shared = loaderData.shared;
  const embedOptions = loaderData.embedOptions;
  type PublicProgrammeActionData = {
    ok?: boolean;
    error?: string;
    shareUrl?: string;
  };
  type PublicProgrammeAction = () => Promise<PublicProgrammeActionData>;
  const fetcher = useFetcher<PublicProgrammeAction>();
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [itineraryVerificationPrompted, setItineraryVerificationPrompted] =
    useState(false);
  const itineraryVerificationRef = useRef<HTMLFieldSetElement | null>(null);
  const previousFetcherState = useRef(fetcher.state);
  const shareUrl =
    fetcher.data &&
    "shareUrl" in fetcher.data &&
    typeof fetcher.data.shareUrl === "string"
      ? fetcher.data.shareUrl
      : null;
  const saved = loaderData.itinerary;
  const initialPublicSearch = useRef(new URLSearchParams(location.search));
  const pendingClientSearches = useRef(new Set<string>());
  const [query, setQueryState] = useState(
    embedded
      ? embedOptions.query
      : (initialPublicSearch.current.get("query") ?? ""),
  );
  const [standaloneDirectoryQuery, setStandaloneDirectoryQueryState] = useState(
    initialPublicSearch.current.get("speakerQuery") ?? "",
  );
  const [standaloneGalleryQuery, setStandaloneGalleryQueryState] = useState(
    initialPublicSearch.current.get("galleryQuery") ?? "",
  );
  const pendingTextQueries = useRef({
    query,
    directory: standaloneDirectoryQuery,
    gallery: standaloneGalleryQuery,
  });
  const days = useMemo(
    () => [
      ...new Set(
        programme.sessions.map((session) =>
          formatDay(session.startsAt, programme.event.timezone),
        ),
      ),
    ],
    [programme],
  );
  const initialEmbedDay = embedOptions.day
    ? programme.sessions.find(
        (session) =>
          eventLocalCalendarDate(session.startsAt, programme.event.timezone) ===
          embedOptions.day,
      )
    : null;
  const tracks = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.track)),
    [programme.sessions],
  );
  const formats = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.format)),
    [programme.sessions],
  );
  const rooms = useMemo(
    () => distinctSorted(programme.sessions.map((session) => session.room)),
    [programme.sessions],
  );
  const requestedInitialDay = initialPublicSearch.current.get("day") ?? "";
  const requestedInitialTrack = initialPublicSearch.current.get("track") ?? "";
  const requestedInitialFormat =
    initialPublicSearch.current.get("format") ?? "";
  const requestedInitialRoom = initialPublicSearch.current.get("room") ?? "";
  const [day, setDay] = useState(
    !embedded && days.includes(requestedInitialDay)
      ? requestedInitialDay
      : initialEmbedDay
        ? formatDay(initialEmbedDay.startsAt, programme.event.timezone)
        : "All days",
  );
  const [track, setTrackState] = useState(
    embedded
      ? (embedOptions.track ?? "")
      : tracks.includes(requestedInitialTrack)
        ? requestedInitialTrack
        : "",
  );
  const [format, setFormatState] = useState(
    embedded
      ? (embedOptions.format ?? "")
      : formats.includes(requestedInitialFormat)
        ? requestedInitialFormat
        : "",
  );
  const [room, setRoomState] = useState(
    embedded
      ? (embedOptions.room ?? "")
      : rooms.includes(requestedInitialRoom)
        ? requestedInitialRoom
        : "",
  );
  const [clearedSavedFilterNotice, setClearedSavedFilterNotice] = useState("");
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
  const visibleEmbedControls = new Set(embedOptions.controls);
  const visibleEmbedFields = new Set(embedOptions.fields);
  const publicSearchWithPendingQueries = useCallback(() => {
    const search = new URLSearchParams(location.search);
    for (const [searchName, pendingValue] of [
      ["query", pendingTextQueries.current.query.trim()],
      ["speakerQuery", pendingTextQueries.current.directory.trim()],
      ["galleryQuery", pendingTextQueries.current.gallery.trim()],
    ] as const) {
      if (pendingValue) search.set(searchName, pendingValue);
      else search.delete(searchName);
    }
    return search;
  }, [location.search]);
  const replacePublicSearchParameter = useCallback(
    (
      name: string,
      value: string,
      { clearSession = false }: { clearSession?: boolean } = {},
    ) => {
      if (embedded) return;
      const search = publicSearchWithPendingQueries();
      if (clearSession) {
        search.delete("session");
        setSessionFocusOverride(null);
      }
      if (value) search.set(name, value);
      else search.delete(name);
      const nextSearch = search.size ? `?${search}` : "";
      pendingClientSearches.current.add(nextSearch);
      void navigate(
        {
          pathname: location.pathname,
          search: nextSearch,
          hash: location.hash,
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [
      embedded,
      location.hash,
      location.pathname,
      navigate,
      publicSearchWithPendingQueries,
    ],
  );
  const setQuery = (value: string) => {
    pendingTextQueries.current.query = value;
    if (!embedded) setSessionFocusOverride(null);
    setQueryState(value);
  };
  const setStandaloneDirectoryQuery = (value: string) => {
    pendingTextQueries.current.directory = value;
    setStandaloneDirectoryQueryState(value);
  };
  const setStandaloneGalleryQuery = (value: string) => {
    pendingTextQueries.current.gallery = value;
    setStandaloneGalleryQueryState(value);
  };
  const setTrack = (value: string) => {
    setTrackState(value);
    replacePublicSearchParameter("track", value, { clearSession: true });
  };
  const setFormat = (value: string) => {
    setFormatState(value);
    replacePublicSearchParameter("format", value, { clearSession: true });
  };
  const setRoom = (value: string) => {
    setRoomState(value);
    replacePublicSearchParameter("room", value, { clearSession: true });
  };
  const setPublicDay = (value: string) => {
    setDay(value);
    replacePublicSearchParameter("day", value === "All days" ? "" : value, {
      clearSession: true,
    });
  };
  const showControl = (control: (typeof embedOptions.controls)[number]) =>
    !embedded || visibleEmbedControls.has(control);
  const showEmbedField = (field: (typeof embedOptions.fields)[number]) =>
    !embedded || visibleEmbedFields.has(field);
  const showSpeakerDirectory = !embedded || embedOptions.showSpeakerDirectory;
  const showSpeakerDetails = showEmbedField("speaker-details");
  useEffect(() => {
    if (!embedded) return;
    const publishHeight = () => {
      window.parent.postMessage(
        {
          type: "programcue:resize",
          eventSlug: programme.event.slug,
          height: Math.ceil(document.documentElement.scrollHeight),
        },
        "*",
      );
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(document.body);
    window.addEventListener("load", publishHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("load", publishHeight);
    };
  }, [embedded, programme.event.slug]);
  useEffect(() => {
    if (embedded) return;
    const nextQuery = query.trim();
    const currentQuery =
      new URLSearchParams(location.search).get("query") ?? "";
    if (nextQuery === currentQuery) return;
    const timer = window.setTimeout(
      () =>
        replacePublicSearchParameter("query", nextQuery, {
          clearSession: true,
        }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [embedded, location.search, query, replacePublicSearchParameter]);
  useEffect(() => {
    if (embedded) return;
    const nextQuery = standaloneDirectoryQuery.trim();
    const currentQuery =
      new URLSearchParams(location.search).get("speakerQuery") ?? "";
    if (nextQuery === currentQuery) return;
    const timer = window.setTimeout(
      () => replacePublicSearchParameter("speakerQuery", nextQuery),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [
    embedded,
    location.search,
    replacePublicSearchParameter,
    standaloneDirectoryQuery,
  ]);
  useEffect(() => {
    if (embedded) return;
    const nextQuery = standaloneGalleryQuery.trim();
    const currentQuery =
      new URLSearchParams(location.search).get("galleryQuery") ?? "";
    if (nextQuery === currentQuery) return;
    const timer = window.setTimeout(
      () => replacePublicSearchParameter("galleryQuery", nextQuery),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [
    embedded,
    location.search,
    replacePublicSearchParameter,
    standaloneGalleryQuery,
  ]);
  useEffect(() => {
    if (embedded) return;
    if (pendingClientSearches.current.delete(location.search)) return;
    if (location.hash.startsWith("#session-")) {
      const legacySessionSlug = location.hash.slice("#session-".length);
      const linkedSession = programme.sessions.find(
        (session) => session.slug === legacySessionSlug,
      );
      if (linkedSession) {
        const search = new URLSearchParams(location.search);
        search.delete("speaker");
        search.set("session", linkedSession.id);
        void navigate(
          {
            pathname: publicProgrammeSurfacePath(
              programme.event.slug,
              "sessions",
            ),
            search: `?${search}`,
            hash: "",
          },
          { replace: true, preventScrollReset: true },
        );
        return;
      }
    }
    const search = new URLSearchParams(location.search);
    const cleaned = clearUnavailablePublicProgrammeFacets(search, {
      day: days,
      track: tracks,
      format: formats,
      room: rooms,
    });
    if (cleaned.cleared.length) {
      setClearedSavedFilterNotice(
        clearedPublicProgrammeFacetMessage(cleaned.cleared),
      );
      const nextSearch = cleaned.search.size ? `?${cleaned.search}` : "";
      pendingClientSearches.current.add(nextSearch);
      void navigate(
        {
          pathname: location.pathname,
          search: nextSearch,
          hash: location.hash,
        },
        { replace: true, preventScrollReset: true },
      );
      return;
    }
    const nextQuery = search.get("query") ?? "";
    const nextDirectoryQuery = search.get("speakerQuery") ?? "";
    const nextGalleryQuery = search.get("galleryQuery") ?? "";
    pendingTextQueries.current = {
      query: nextQuery,
      directory: nextDirectoryQuery,
      gallery: nextGalleryQuery,
    };
    setQueryState(nextQuery);
    setStandaloneDirectoryQueryState(nextDirectoryQuery);
    setStandaloneGalleryQueryState(nextGalleryQuery);
    const requestedDay = search.get("day") ?? "";
    const requestedTrack = search.get("track") ?? "";
    const requestedFormat = search.get("format") ?? "";
    const requestedRoom = search.get("room") ?? "";
    setDay(days.includes(requestedDay) ? requestedDay : "All days");
    setTrackState(tracks.includes(requestedTrack) ? requestedTrack : "");
    setFormatState(formats.includes(requestedFormat) ? requestedFormat : "");
    setRoomState(rooms.includes(requestedRoom) ? requestedRoom : "");
  }, [
    days,
    embedded,
    formats,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    programme.event.slug,
    programme.sessions,
    rooms,
    tracks,
  ]);
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

  useEffect(() => {
    if (previousFetcherState.current !== "idle" && fetcher.state === "idle") {
      setTurnstileResetKey((value) => value + 1);
    }
    previousFetcherState.current = fetcher.state;
  }, [fetcher.state]);

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

  function clearFilters() {
    if (showControl("search")) setQueryState("");
    if (showControl("day")) setDay("All days");
    if (showControl("track")) setTrackState("");
    if (showControl("format")) setFormatState("");
    if (showControl("room")) setRoomState("");
    if (!embedded) {
      setSessionFocusOverride(null);
      const search = new URLSearchParams(location.search);
      if (showControl("search")) search.delete("query");
      if (showControl("day")) search.delete("day");
      if (showControl("track")) search.delete("track");
      if (showControl("format")) search.delete("format");
      if (showControl("room")) search.delete("room");
      search.delete("session");
      const nextSearch = search.size ? `?${search}` : "";
      pendingClientSearches.current.add(nextSearch);
      void navigate(
        {
          pathname: location.pathname,
          search: nextSearch,
          hash: location.hash,
        },
        { replace: true, preventScrollReset: true },
      );
    }
  }

  function selectSavedSession(sessionId: string) {
    if (!visibleSessionIds.has(sessionId)) clearFilters();
    else setSessionFocusOverride(null);
    setSelectedId(sessionId);
  }

  function requiresItineraryVerification(sessionId: string) {
    return (
      !saved.includes(sessionId) &&
      loaderData.itineraryVerificationRequired &&
      loaderData.turnstileSiteKey !== null &&
      !turnstileToken
    );
  }

  function updateTurnstileToken(token: string) {
    setTurnstileToken(token);
    if (token) setItineraryVerificationPrompted(false);
  }

  function toggle(sessionId: string) {
    if (shared) return;
    if (requiresItineraryVerification(sessionId)) {
      setItineraryVerificationPrompted(true);
      window.requestAnimationFrame(() => {
        const verification = itineraryVerificationRef.current;
        verification?.focus({ preventScroll: true });
        verification?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "center",
        });
      });
      return;
    }
    void fetcher.submit(
      {
        intent: saved.includes(sessionId) ? "remove" : "add",
        sessionId,
        "turnstile-token": turnstileToken,
      },
      { method: "post" },
    );
  }
  return {
    loaderData,
    surface: loaderData.surface,
    programme,
    embedded,
    shared,
    embedOptions,
    fetcher,
    turnstileToken,
    updateTurnstileToken,
    turnstileResetKey,
    itineraryVerificationPrompted,
    itineraryVerificationRef,
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
    requiresItineraryVerification,
    toggle,
  };
}

export type PublicProgrammeModel = ReturnType<typeof usePublicProgrammeModel>;
