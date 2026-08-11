import type React from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { Link } from "react-router";

import { TurnstileWidget } from "~/components/turnstile-widget";
import { formatProgrammeEventDay } from "~/modules/programme/programme-presentation";
import type { PublicProgrammeLoaderData } from "~/routes/public-programme";
import {
  descriptionSnippet,
  formatDay,
  formatTime,
  initials,
  normaliseDescription,
  speakerAffiliation,
  usePublicProgrammeModel,
} from "~/components/public-programme-model";

export function PublicProgrammeWorkspace({
  loaderData: initialLoaderData,
}: {
  loaderData: PublicProgrammeLoaderData;
}) {
  const {
    loaderData,
    programme,
    embedded,
    shared,
    embedOptions,
    fetcher,
    turnstileToken,
    setTurnstileToken,
    turnstileResetKey,
    shareUrl,
    saved,
    query,
    setQuery,
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
    selectedId,
    setSelectedId,
    speakerProfileRef,
    showControl,
    showSpeakers,
    visible,
    filtersActive,
    clearableFiltersActive,
    selected,
    visibleSpeakers,
    selectedSpeaker,
    selectedSpeakerSessions,
    savedSessions,
    itineraryConflicts,
    openSpeakerProfile,
    closeSpeakerProfile,
    toggleDescription,
    clearFilters,
    selectSavedSession,
    toggle,
  } = usePublicProgrammeModel(initialLoaderData);
  return (
    <div
      className={`public-shell event-branded${embedded ? " embedded" : ""}${embedded && embedOptions.density === "compact" ? " embed-compact" : ""}`}
      style={
        {
          "--event-accent": embedOptions.accent ?? programme.event.brandAccent,
        } as React.CSSProperties
      }
    >
      {!embedded ? (
        <header className="public-top">
          <Link
            className="brand"
            to={`/public/programme/${programme.event.slug}`}
            style={{ color: "var(--ink)", padding: 0 }}
          >
            <span className="brand-mark">P</span>
            <span>Program Cue</span>
          </Link>
          <nav className="public-nav" aria-label="Programme">
            <a className="active" href="#programme" aria-current="page">
              Programme
            </a>
            {showSpeakers ? <a href="#speakers">Speakers</a> : null}
          </nav>
          <details className="public-mobile-nav">
            <summary className="btn small">Browse</summary>
            <nav aria-label="Programme sections">
              <a href="#programme" aria-current="page">
                Programme
              </a>
              {showSpeakers ? <a href="#speakers">Speakers</a> : null}
            </nav>
          </details>
          <a className="btn" href="#itinerary">
            ♡ {shared ? "Shared itinerary" : "My itinerary"}{" "}
            <span className="status info">{saved.length}</span>
          </a>
        </header>
      ) : null}
      <section
        className="hero"
        style={
          {
            "--event-accent":
              embedOptions.accent ?? programme.event.brandAccent,
            background: embedOptions.accent
              ? `linear-gradient(135deg, #0f172a, ${embedOptions.accent})`
              : undefined,
          } as React.CSSProperties
        }
      >
        <span className="status info">
          Published version {programme.version.versionNumber}
        </span>
        <h1>{programme.event.name}</h1>
        <p
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <CalendarDays aria-hidden="true" size={15} />{" "}
          <span>
            {formatProgrammeEventDay(programme.event.startDate)}–
            {formatProgrammeEventDay(programme.event.endDate)}
          </span>
          <span aria-hidden="true">·</span>
          <MapPin aria-hidden="true" size={15} />{" "}
          <span>
            {[programme.event.venue, programme.event.city]
              .filter(Boolean)
              .join(", ")}
          </span>
        </p>
      </section>
      <main id="main" className="public-main">
        <div className="public-content" id="programme">
          {fetcher.data && "error" in fetcher.data ? (
            <div className="validation-item error mb" role="alert">
              <strong>Itinerary not updated</strong>
              <span>{String(fetcher.data.error)}</span>
            </div>
          ) : null}
          {shareUrl ? (
            <div className="validation-item ok mb" role="status">
              <strong>Share link ready</strong>
              <a href={shareUrl}>{shareUrl}</a>
              <span>The link is read-only. Creating another rotates it.</span>
            </div>
          ) : null}
          {embedOptions.controls.length || !embedded ? (
            <div className="public-filters">
              {showControl("search") ? (
                <input
                  className="field"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search sessions, speakers, or topics"
                  aria-label="Search sessions, speakers, or topics"
                  style={{ flex: 1 }}
                />
              ) : null}
              {showControl("day") ? (
                <select
                  className="select"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                  aria-label="Filter by day"
                >
                  <option>All days</option>
                  {days.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              ) : null}
              {showControl("track") && tracks.length > 1 ? (
                <select
                  className="select"
                  value={track}
                  onChange={(event) => setTrack(event.target.value)}
                  aria-label="Filter by track"
                >
                  <option value="">All tracks</option>
                  {tracks.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              ) : null}
              {showControl("format") && formats.length > 1 ? (
                <select
                  className="select"
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                  aria-label="Filter by format"
                >
                  <option value="">All formats</option>
                  {formats.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              ) : null}
              {showControl("room") && rooms.length > 1 ? (
                <select
                  className="select"
                  value={room}
                  onChange={(event) => setRoom(event.target.value)}
                  aria-label="Filter by room"
                >
                  <option value="">All rooms</option>
                  {rooms.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={clearFilters}
                disabled={!clearableFiltersActive}
              >
                Clear filters
              </button>
            </div>
          ) : null}
          <p className="public-filter-summary help" role="status">
            Showing {visible.length} of {programme.sessions.length} published
            session{programme.sessions.length === 1 ? "" : "s"}
            {filtersActive ? " for the current filters" : ""}.
          </p>
          <div className="programme-list">
            {visible.length ? (
              visible.map((session) => {
                const sessionSpeakers = session.speakerIds.map(
                  (speakerId, index) => {
                    const speaker = speakerById.get(speakerId)!;
                    return {
                      id: speakerId,
                      name: session.speakerNames[index]!,
                      affiliation: speakerAffiliation(speaker),
                    };
                  },
                );
                const description = normaliseDescription(session.description);
                const snippet = descriptionSnippet(description);
                const expanded = expandedDescriptions.includes(session.id);
                return (
                  <div
                    className={`programme-entry${session.id === selected?.id ? " active" : ""}`}
                    key={session.id}
                  >
                    <button
                      type="button"
                      id={`session-${session.slug}`}
                      className={`programme-row${session.id === selected?.id ? " active" : ""}`}
                      aria-pressed={session.id === selected?.id}
                      onClick={() => setSelectedId(session.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        borderTop: 0,
                        borderLeft: 0,
                        borderRight: 0,
                      }}
                    >
                      <div>
                        <strong>
                          {formatTime(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </strong>
                        <small className="subtle" style={{ display: "block" }}>
                          {formatDay(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </small>
                      </div>
                      <div>
                        <span className="pill">{session.format}</span>
                        <h3>{session.title}</h3>
                        <div className="programme-row-speakers">
                          {sessionSpeakers.length ? (
                            sessionSpeakers.map((speaker) => (
                              <div
                                className="programme-row-speaker"
                                key={speaker.id}
                              >
                                <span className="speaker">{speaker.name}</span>
                                {speaker.affiliation ? (
                                  <small className="subtle programme-row-affiliation">
                                    {" "}
                                    <span aria-hidden="true">— </span>
                                    {speaker.affiliation}
                                  </small>
                                ) : null}
                              </div>
                            ))
                          ) : (
                            <span className="speaker">
                              Speaker to be announced
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="room-col">
                        <strong>{session.room}</strong>
                        <small className="subtle" style={{ display: "block" }}>
                          {[session.building, session.level]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <div className="track-col">{session.track}</div>
                      <div>
                        {!embedded && saved.includes(session.id) ? (
                          <span className="status success">Saved ✓</span>
                        ) : !embedded && !shared ? (
                          <span className="pill">＋</span>
                        ) : null}
                      </div>
                    </button>
                    {snippet ? (
                      <div className="programme-entry-description">
                        <p id={`session-description-${session.id}`}>
                          {expanded ? description : snippet}
                        </p>
                        {snippet === description ? null : (
                          <button
                            type="button"
                            className="btn small"
                            aria-expanded={expanded}
                            aria-controls={`session-description-${session.id}`}
                            aria-label={`${expanded ? "Show less" : "Show more"} of the ${session.title} description`}
                            onClick={() => toggleDescription(session.id)}
                          >
                            {expanded ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <section className="card pad">
                <h2>No matching sessions</h2>
                <p className="subtle">Clear a filter or broaden the search.</p>
                {clearableFiltersActive ? (
                  <button type="button" className="btn" onClick={clearFilters}>
                    Clear filters
                  </button>
                ) : null}
              </section>
            )}
          </div>
          <section
            id="speakers"
            className="mt"
            aria-labelledby="speakers-title"
            hidden={!showSpeakers}
          >
            <div className="card-title">
              <div>
                <span className="pc-page-eyebrow">Meet the programme</span>
                <h2 id="speakers-title">Speakers</h2>
              </div>
              <span className="status info">{visibleSpeakers.length}</span>
            </div>
            {visibleSpeakers.length ? (
              <div className="grid grid-3">
                {visibleSpeakers.map((speaker) => (
                  <article
                    id={`speaker-${speaker.id}`}
                    className="card pad"
                    key={speaker.id}
                  >
                    <div className="row-main mb">
                      {speaker.imageUrl ? (
                        <img
                          className="avatar"
                          src={speaker.imageUrl}
                          alt=""
                          width={48}
                          height={48}
                        />
                      ) : (
                        <span className="avatar" aria-hidden="true">
                          {speaker.displayName
                            .split(" ")
                            .map((part) => part[0])
                            .join("")
                            .slice(0, 2)}
                        </span>
                      )}
                      <div>
                        <h3>{speaker.displayName}</h3>
                        <p className="help">
                          {[speaker.jobTitle, speaker.organisationName]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </div>
                    <p>
                      {speaker.biography
                        ? descriptionSnippet(speaker.biography)
                        : "Biography coming soon."}
                    </p>
                    <p className="help">
                      {speaker.sessionIds.length} session
                      {speaker.sessionIds.length === 1 ? "" : "s"}
                    </p>
                    <a
                      className="btn small"
                      id={`speaker-profile-link-${speaker.id}`}
                      href="#programme-speaker-profile"
                      aria-label={`View profile and sessions for ${speaker.displayName}`}
                      onClick={(event) =>
                        openSpeakerProfile(speaker.id, event.currentTarget)
                      }
                    >
                      View profile and sessions
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                <p>No speakers match this search.</p>
              </div>
            )}
            {selectedSpeaker ? (
              <article
                className="card pad mt"
                id="programme-speaker-profile"
                aria-live="polite"
                aria-labelledby="programme-speaker-profile-name"
                tabIndex={-1}
                ref={speakerProfileRef}
              >
                <div className="card-title">
                  <div>
                    <span className="pill">Speaker profile</span>
                    <h2 id="programme-speaker-profile-name">
                      {selectedSpeaker.displayName}
                    </h2>
                    <p className="help">
                      {[
                        selectedSpeaker.jobTitle,
                        selectedSpeaker.organisationName,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Role and organisation to be confirmed"}
                    </p>
                  </div>
                  <div className="public-profile-actions">
                    <a
                      className="btn small"
                      href={`#speaker-${selectedSpeaker.id}`}
                    >
                      Share profile link
                    </a>
                    <button
                      type="button"
                      className="btn small"
                      onClick={closeSpeakerProfile}
                    >
                      Close profile
                    </button>
                  </div>
                </div>
                {selectedSpeaker.pronunciation ? (
                  <p className="help">
                    Pronunciation · {selectedSpeaker.pronunciation}
                  </p>
                ) : null}
                <p>{selectedSpeaker.biography || "Biography coming soon."}</p>
                <h3>
                  Sessions{" "}
                  <span className="status info">
                    {selectedSpeakerSessions.length}
                  </span>
                </h3>
                <div className="stack">
                  {selectedSpeakerSessions.length ? (
                    selectedSpeakerSessions.map((session) => (
                      <a
                        href={`#session-${session.slug}`}
                        key={session.id}
                        onClick={() => setSelectedId(session.id)}
                      >
                        {formatDay(session.startsAt, programme.event.timezone)}{" "}
                        ·{" "}
                        {formatTime(session.startsAt, programme.event.timezone)}{" "}
                        · {session.title} · {session.room}
                      </a>
                    ))
                  ) : (
                    <p className="subtle">
                      No sessions match the current filters.
                    </p>
                  )}
                </div>
              </article>
            ) : null}
          </section>
        </div>
        <aside id="itinerary">
          {!embedded ? (
            <section
              className="card itinerary"
              aria-busy={fetcher.state !== "idle" || undefined}
            >
              <div className="card-title">
                <h2>{shared ? "Shared itinerary" : "My itinerary"}</h2>
                <span className="status info right">{saved.length}</span>
              </div>
              {itineraryConflicts.length ? (
                <div className="validation-item warn">
                  <strong>Schedule conflict</strong>
                  <p>{itineraryConflicts[0].join(" overlaps ")}</p>
                </div>
              ) : null}
              {fetcher.data &&
              "error" in fetcher.data &&
              typeof fetcher.data.error === "string" ? (
                <p className="validation-item error" role="alert">
                  {fetcher.data.error}
                </p>
              ) : null}
              {loaderData.itineraryVerificationRequired ? (
                <div className="stack mb">
                  <p className="help">
                    Complete the security check once to start this browser's
                    itinerary.
                  </p>
                  <TurnstileWidget
                    siteKey={loaderData.turnstileSiteKey}
                    action="public_itinerary_create"
                    onTokenChange={setTurnstileToken}
                    resetKey={turnstileResetKey}
                  />
                </div>
              ) : null}
              {savedSessions.length ? (
                <>
                  {savedSessions.map((session) => {
                    const sessionSpeakers = session.speakerIds.map(
                      (speakerId, index) => {
                        const speaker = speakerById.get(speakerId)!;
                        return {
                          id: speakerId,
                          name: session.speakerNames[index]!,
                          affiliation: speakerAffiliation(speaker),
                        };
                      },
                    );
                    return (
                      <button
                        type="button"
                        className="itinerary-item"
                        style={{ width: "100%", textAlign: "left" }}
                        key={session.id}
                        aria-pressed={session.id === selected?.id}
                        onClick={() => selectSavedSession(session.id)}
                      >
                        <strong>
                          {formatDay(
                            session.startsAt,
                            programme.event.timezone,
                          )}{" "}
                          ·{" "}
                          {formatTime(
                            session.startsAt,
                            programme.event.timezone,
                          )}
                        </strong>
                        <span className="itinerary-title">{session.title}</span>
                        <span className="itinerary-meta">
                          {[session.room, session.format, session.track]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {sessionSpeakers.length ? (
                          <span className="itinerary-speakers">
                            {sessionSpeakers.map((speaker) => (
                              <span key={speaker.id}>
                                {speaker.name}
                                {speaker.affiliation
                                  ? ` — ${speaker.affiliation}`
                                  : ""}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {!shared ? (
                    <fetcher.Form method="post" className="mt">
                      <input type="hidden" name="intent" value="share" />
                      <button
                        className="btn"
                        type="submit"
                        disabled={fetcher.state !== "idle"}
                      >
                        Create read-only share link
                      </button>
                    </fetcher.Form>
                  ) : null}
                  {loaderData.itinerarySynced && !shared ? (
                    <p className="help">
                      Synced to your signed-in account across devices.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="subtle">No saved sessions yet.</p>
              )}
            </section>
          ) : null}
          {selected ? (
            <section className="card session-detail-panel mt">
              <div className="card-title">
                <span className="pill">{selected.format}</span>
              </div>
              <h2>{selected.title}</h2>
              <div className="stack mb">
                {selected.speakerIds.length ? (
                  selected.speakerIds.map((speakerId, index) => {
                    const speaker = speakerById.get(speakerId)!;
                    const name = selected.speakerNames[index]!;
                    const affiliation = speakerAffiliation(speaker);
                    return (
                      <div className="row-main" key={speakerId}>
                        {speaker.imageUrl ? (
                          <img
                            className="avatar"
                            src={speaker.imageUrl}
                            alt=""
                            width={40}
                            height={40}
                          />
                        ) : (
                          <span className="avatar" aria-hidden="true">
                            {initials(name)}
                          </span>
                        )}
                        <div>
                          <strong>{name}</strong>
                          <small>
                            {affiliation ||
                              "Role and organisation not provided"}
                          </small>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="row-main">
                    <span className="avatar" aria-hidden="true">
                      PC
                    </span>
                    <div>
                      <strong>Speaker to be announced</strong>
                      <small>{selected.track}</small>
                    </div>
                  </div>
                )}
              </div>
              {!embedded && !shared ? (
                <button
                  type="button"
                  className={`btn${saved.includes(selected.id) ? "" : " primary"}`}
                  disabled={
                    fetcher.state !== "idle" ||
                    (!saved.includes(selected.id) &&
                      loaderData.itineraryVerificationRequired &&
                      loaderData.turnstileSiteKey !== null &&
                      !turnstileToken)
                  }
                  onClick={() => toggle(selected.id)}
                >
                  {fetcher.state !== "idle"
                    ? "Updating itinerary…"
                    : saved.includes(selected.id)
                      ? "Remove from itinerary"
                      : "Add to itinerary"}
                </button>
              ) : null}
              <h3>About this session</h3>
              <p>{selected.description || "A description is coming soon."}</p>
              <Link
                className="btn small"
                to={`/public/programme/${programme.event.slug}#session-${selected.slug}`}
              >
                Shareable session link
              </Link>
              {showSpeakers && selected.speakerIds.length ? (
                <div className="stack mt">
                  {selected.speakerIds.map((speakerId, index) => (
                    <a
                      key={speakerId}
                      href={`#speaker-${speakerId}`}
                      onClick={(event) =>
                        openSpeakerProfile(speakerId, event.currentTarget)
                      }
                    >
                      View {selected.speakerNames[index]}’s profile
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="divider" />
              <h3>Details</h3>
              <dl className="public-detail-list">
                <dt>When</dt>
                <dd>
                  {formatDay(selected.startsAt, programme.event.timezone)} ·{" "}
                  {formatTime(selected.startsAt, programme.event.timezone)}–
                  {formatTime(selected.endsAt, programme.event.timezone)}
                </dd>
                <dt>Where</dt>
                <dd>
                  {[selected.room, selected.building, selected.level]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
                <dt>Track</dt>
                <dd>{selected.track ?? "Not assigned to a public track"}</dd>
                <dt>Format</dt>
                <dd>{selected.format}</dd>
              </dl>
            </section>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
