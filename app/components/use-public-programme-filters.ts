import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { publicProgrammeSurfacePath } from "~/modules/programme/programme-presentation";
import {
  clearedPublicProgrammeFacetMessage,
  clearUnavailablePublicProgrammeFacets,
} from "~/modules/programme/public-programme-filter-state";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import {
  distinctSorted,
  formatDay,
  type PublicProgrammeLoaderData,
} from "./public-programme-model-helpers";

// Pending text edits and URL acknowledgements share one lifecycle. A router
// revalidation must not replace an unacknowledged query typed by the visitor.
export function usePublicProgrammeFilters(
  loaderData: PublicProgrammeLoaderData,
  setSessionFocusOverride: (value: string | null | undefined) => void,
) {
  const { programme, embedded, embedOptions } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
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
  const visibleEmbedControls = new Set(embedOptions.controls);
  const showControl = (control: (typeof embedOptions.controls)[number]) =>
    !embedded || visibleEmbedControls.has(control);
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
      setSessionFocusOverride,
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
  function clearFilters() {
    if (showControl("search")) setQuery("");
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

  return {
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
  };
}
