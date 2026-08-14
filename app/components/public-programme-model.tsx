import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLocation } from "react-router";

import type { parseProgrammeEmbedSearchParameters } from "~/modules/programme/programme-embed-configuration";
import {
  sortPublishedSpeakers,
  type PublicProgrammeSurface,
} from "~/modules/programme/programme-presentation";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import type {
  PublishedProgramme,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";

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

export function initials(name: string) {
  return (
    name
      .split(/\s+/u)
      .map((part) => part[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2) || "PC"
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
  const itineraryVerificationRef = useRef<HTMLDivElement | null>(null);
  const previousFetcherState = useRef(fetcher.state);
  const shareUrl =
    fetcher.data &&
    "shareUrl" in fetcher.data &&
    typeof fetcher.data.shareUrl === "string"
      ? fetcher.data.shareUrl
      : null;
  const saved = loaderData.itinerary;
  const [query, setQuery] = useState(embedOptions.query);
  const [standaloneDirectoryQuery, setStandaloneDirectoryQuery] = useState("");
  const [standaloneGalleryQuery, setStandaloneGalleryQuery] = useState("");
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
  const [day, setDay] = useState(
    initialEmbedDay
      ? formatDay(initialEmbedDay.startsAt, programme.event.timezone)
      : "All days",
  );
  const [track, setTrack] = useState(embedOptions.track ?? "");
  const [format, setFormat] = useState(embedOptions.format ?? "");
  const [room, setRoom] = useState(embedOptions.room ?? "");
  const [expandedDescriptions, setExpandedDescriptions] = useState<string[]>(
    [],
  );
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
  const [selectedId, setSelectedId] = useState(programme.sessions[0]?.id ?? "");
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [expandedSpeakerBiography, setExpandedSpeakerBiography] =
    useState(false);
  const speakerProfileRef = useRef<HTMLElement | null>(null);
  const speakerProfileReturnFocusRef = useRef<HTMLElement | null>(null);
  const visibleEmbedControls = new Set(embedOptions.controls);
  const visibleEmbedFields = new Set(embedOptions.fields);
  const showControl = (control: (typeof embedOptions.controls)[number]) =>
    !embedded || visibleEmbedControls.has(control);
  const showEmbedField = (field: (typeof embedOptions.fields)[number]) =>
    !embedded || visibleEmbedFields.has(field);
  const showSpeakers = !embedded || embedOptions.showSpeakers;
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
    if (location.hash.startsWith("#session-")) {
      const slug = location.hash.slice("#session-".length);
      const linked = programme.sessions.find(
        (session) => session.slug === slug,
      );
      if (linked) setSelectedId(linked.id);
    } else if (showSpeakers && location.hash.startsWith("#speaker-")) {
      const personId = location.hash.slice("#speaker-".length);
      const linked = programme.speakers.find(
        (speaker) => speaker.id === personId,
      );
      if (linked) setSelectedSpeakerId(linked.id);
    }
  }, [location.hash, programme.sessions, programme.speakers, showSpeakers]);
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
  const selected =
    visible.find((session) => session.id === selectedId) ?? visible[0] ?? null;
  const visibleSessionIds = new Set(visible.map((session) => session.id));
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
  const selectedSpeaker =
    visibleSpeakers.find((speaker) => speaker.id === selectedSpeakerId) ?? null;
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

  useEffect(() => {
    setExpandedSpeakerBiography(false);
  }, [selectedSpeakerId]);

  // Do not silently reopen a profile if later filter changes remove its
  // speaker from the result set and those filters are subsequently cleared.
  useEffect(() => {
    if (selectedSpeakerId && !selectedSpeaker) {
      setSelectedSpeakerId("");
      speakerProfileReturnFocusRef.current = null;
    }
  }, [selectedSpeaker, selectedSpeakerId]);

  function openSpeakerProfile(speakerId: string, trigger: HTMLElement) {
    speakerProfileReturnFocusRef.current = trigger;
    setSelectedSpeakerId(speakerId);
  }

  function closeSpeakerProfile() {
    const returnFocus = speakerProfileReturnFocusRef.current;
    const fallbackTargets = [
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
    ];
    const focusTarget =
      fallbackTargets.find((element): element is HTMLElement =>
        Boolean(element?.isConnected),
      ) ?? null;
    setSelectedSpeakerId("");
    speakerProfileReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      focusTarget?.focus();
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
    if (showControl("search")) setQuery("");
    if (showControl("day")) setDay("All days");
    if (showControl("track")) setTrack("");
    if (showControl("format")) setFormat("");
    if (showControl("room")) setRoom("");
  }

  function selectSavedSession(sessionId: string) {
    if (!visibleSessionIds.has(sessionId)) clearFilters();
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
    setDay,
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
    speakerProfileRef,
    showControl,
    showEmbedField,
    showSpeakers,
    visible,
    filtersActive,
    clearableFiltersActive,
    selected,
    visibleSpeakers,
    selectedSpeaker,
    selectedSpeakerSessions,
    selectedSpeakerAllSessions,
    expandedSpeakerBiography,
    savedSessions,
    itineraryConflicts,
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
