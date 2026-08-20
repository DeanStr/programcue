import {
  formatDay,
  groupSessionsByDay,
  type PublicProgrammeModel,
} from "./public-programme-model";
import {
  ProgrammeDayHeading,
  SaveSessionButton,
  SessionPlace,
  SessionTags,
  SessionTime,
} from "./public-programme-parts";
import {
  PublicDayTabs,
  PublicSessionSpeakerNames,
  PublicSessionSpeakers,
  SessionCardDescription,
  SurfaceHeading,
} from "./public-programme-surface-shared";

/**
 * The information-rich chronological read. Schedule keeps this stable meaning;
 * Timetable owns the separate room-by-time comparison.
 */
export function PublicScheduleSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const activeDay =
    model.day === "All days" ? (model.days[0] ?? "All days") : model.day;
  const days = groupSessionsByDay(
    model.embedded && model.day === "All days"
      ? model.visible
      : model.visible.filter(
          (session) =>
            formatDay(session.startsAt, model.programme.event.timezone) ===
            activeDay,
        ),
    model.programme.event.timezone,
  );
  const sessionCount = days.reduce(
    (total, group) => total + group.sessions.length,
    0,
  );
  return (
    <section className="public-surface" aria-labelledby="public-schedule-title">
      <SurfaceHeading
        title="Day-by-day schedule"
        id="public-schedule-title"
        description="Browse the published programme in chronological order, with the details included in this view."
        count={`${sessionCount} sessions`}
      />
      {!model.embedded && model.showControl("day") ? (
        <PublicDayTabs model={model} label="Day-by-day schedule days" />
      ) : null}
      {days.length ? (
        days.map((group) => (
          <section className="public-itinerary-day" key={group.key}>
            <ProgrammeDayHeading
              label={group.label}
              count={group.sessions.length}
            />
            <ol className="public-itinerary-list" aria-label={group.label}>
              {group.sessions.map((session) => (
                <li
                  className={`public-itinerary-card${model.showEmbedField("time") ? "" : " without-time"}`}
                  key={session.id}
                >
                  {model.showEmbedField("time") ? (
                    <div className="public-itinerary-time">
                      <SessionTime
                        session={session}
                        timezone={model.programme.event.timezone}
                      />
                    </div>
                  ) : null}
                  <div className="public-itinerary-content">
                    <div className="public-itinerary-title-row">
                      <h2>{session.title}</h2>
                      {model.embedded || model.shared ? null : (
                        <SaveSessionButton session={session} model={model} />
                      )}
                    </div>
                    {model.showEmbedField("location") ||
                    model.showEmbedField("track") ||
                    model.showEmbedField("format") ? (
                      <div className="public-itinerary-meta">
                        {model.showEmbedField("location") ? (
                          <SessionPlace session={session} />
                        ) : null}
                        {model.showEmbedField("track") ||
                        model.showEmbedField("format") ? (
                          <SessionTags
                            session={session}
                            showTrack={model.showEmbedField("track")}
                            showFormat={model.showEmbedField("format")}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {model.showEmbedField("description") ? (
                      <SessionCardDescription session={session} model={model} />
                    ) : null}
                    {model.showSpeakerDetails ? (
                      <PublicSessionSpeakers session={session} model={model} />
                    ) : (
                      <PublicSessionSpeakerNames
                        session={session}
                        model={model}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))
      ) : (
        <p className="empty">No published sessions match the current day.</p>
      )}
    </section>
  );
}
