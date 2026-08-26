import { Button } from "~/components/ui/button";
import {
  formatProgrammeTimeRange,
  publicSessionDetailPath,
} from "~/modules/programme/programme-presentation";
import type { PublishedSpeaker } from "~/modules/programme/public-programme-service.server";
import {
  descriptionSnippet,
  formatDay,
  normaliseDescription,
  type PublicProgrammeModel,
} from "./public-programme-model";
import { PublicSpeakerShareActions } from "./public-programme-parts";
import {
  PublicSpeakerMetadata,
  PublicSpeakerPhoto,
  SPARSE_SPEAKER_SEARCH,
  SpeakerSearchField,
  SurfaceHeading,
} from "./public-programme-surface-shared";

function SpeakerDirectoryCard({
  speaker,
  model,
}: {
  speaker: PublishedSpeaker;
  model: PublicProgrammeModel;
}) {
  const content = (
    <>
      {model.showSpeakerDetails && model.showEmbedField("images") ? (
        <PublicSpeakerPhoto speaker={speaker} />
      ) : null}
      <span className="public-speaker-directory-copy">
        <strong>{speaker.displayName}</strong>
        {model.showSpeakerDetails && model.showEmbedField("affiliations") ? (
          <PublicSpeakerMetadata speaker={speaker} />
        ) : null}
        {model.showSpeakerDetails &&
        model.showEmbedField("biography") &&
        speaker.biography ? (
          <span className="public-speaker-directory-bio">
            {descriptionSnippet(speaker.biography)}
          </span>
        ) : null}
        {model.showSpeakerDetails && model.showEmbedField("sessions") ? (
          <span className="help">
            {speaker.sessionIds.length} public session
            {speaker.sessionIds.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {model.showSpeakerDetails ? (
          <span className="public-speaker-profile-cue">View profile</span>
        ) : null}
      </span>
    </>
  );
  return model.showSpeakerDetails ? (
    <article className="public-speaker-directory-card">
      <button
        type="button"
        className="public-speaker-directory-trigger"
        id={`public-speaker-card-${speaker.id}`}
        aria-label={`Open speaker details for ${speaker.displayName}`}
        onClick={(event) =>
          model.openSpeakerProfile(speaker.id, event.currentTarget)
        }
      >
        {content}
      </button>
    </article>
  ) : (
    <article
      className="public-speaker-directory-card"
      id={`public-speaker-card-${speaker.id}`}
    >
      <div className="public-speaker-directory-trigger is-static">
        {content}
      </div>
    </article>
  );
}

export function PublicSpeakersSurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const publishedCount =
    model.orderedSpeakers?.length ?? model.directorySpeakers.length;
  const sparse = publishedCount <= SPARSE_SPEAKER_SEARCH;
  const showSearch = !model.embedded && model.showControl("search");
  const pair = model.directorySpeakers.length <= 2;
  return (
    <section
      className={`public-surface public-speakers-surface${pair ? " is-pair" : ""}`}
      aria-labelledby="public-speakers-title"
    >
      <SurfaceHeading
        kicker="The people on stage"
        title="Speakers"
        id="public-speakers-title"
        description={
          sparse ? undefined : "Meet the people presenting this event."
        }
        count={
          sparse ? undefined : `${model.directorySpeakers.length} speakers`
        }
        sparse={sparse}
      >
        {showSearch ? (
          <SpeakerSearchField
            id="public-speaker-search"
            value={model.directoryQuery}
            onChange={model.setDirectoryQuery}
            label="Search speakers by name"
          />
        ) : null}
      </SurfaceHeading>
      <div className={`public-speaker-directory-grid${pair ? " is-pair" : ""}`}>
        {model.directorySpeakers.length ? (
          model.directorySpeakers.map((speaker) => (
            <SpeakerDirectoryCard
              key={speaker.id}
              speaker={speaker}
              model={model}
            />
          ))
        ) : (
          <p className="empty">No speakers match this search.</p>
        )}
      </div>
      {model.selectedSpeaker ? (
        <SpeakerDetailPanel model={model} variant="directory" />
      ) : null}
    </section>
  );
}

function SpeakerGalleryCard({
  speaker,
  model,
}: {
  speaker: PublishedSpeaker;
  model: PublicProgrammeModel;
}) {
  const content = (
    <>
      {model.showSpeakerDetails && model.showEmbedField("images") ? (
        <PublicSpeakerPhoto speaker={speaker} />
      ) : null}
      <span className="speaker-gallery-card-copy">
        <strong>{speaker.displayName}</strong>
        {model.showSpeakerDetails && model.showEmbedField("affiliations") ? (
          <PublicSpeakerMetadata speaker={speaker} />
        ) : null}
        {model.showSpeakerDetails && model.showEmbedField("sessions") ? (
          <span className="speaker-gallery-card-sessions">
            {speaker.sessionIds.length} session
            {speaker.sessionIds.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {model.showSpeakerDetails ? (
          <span className="public-speaker-profile-cue">View profile</span>
        ) : null}
      </span>
    </>
  );
  return model.showSpeakerDetails ? (
    <button
      type="button"
      className="speaker-gallery-card"
      id={`speaker-gallery-card-${speaker.id}`}
      aria-label={`Open speaker details for ${speaker.displayName}`}
      onClick={(event) =>
        model.openSpeakerProfile(speaker.id, event.currentTarget)
      }
    >
      {content}
    </button>
  ) : (
    <article
      className="speaker-gallery-card is-static"
      id={`speaker-gallery-card-${speaker.id}`}
    >
      {content}
    </article>
  );
}

function SpeakerDetailPanel({
  model,
  variant,
}: {
  model: PublicProgrammeModel;
  variant: "directory" | "gallery";
}) {
  const speaker = model.selectedSpeaker;
  if (!speaker) return null;
  const biography = normaliseDescription(speaker.biography ?? "");
  const biographySnippet = descriptionSnippet(biography);
  const biographyIsLong = biographySnippet !== biography;
  const biographyId = `${variant}-speaker-biography-${speaker.id}`;
  return (
    <article
      className={`card pad public-speaker-detail${variant === "gallery" ? " public-speaker-gallery-detail" : ""}`}
      id={
        variant === "gallery"
          ? "speaker-gallery-detail"
          : "public-speaker-detail"
      }
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${variant}-speaker-detail-name`}
      tabIndex={-1}
      ref={model.speakerProfileRef}
    >
      <div className="public-speaker-detail-heading">
        {model.showEmbedField("images") ? (
          <PublicSpeakerPhoto speaker={speaker} large />
        ) : null}
        <div>
          <h2 id={`${variant}-speaker-detail-name`}>{speaker.displayName}</h2>
          {model.showEmbedField("affiliations") ? (
            <PublicSpeakerMetadata speaker={speaker} />
          ) : null}
          <div className="public-profile-actions">
            {!model.embedded ? (
              <PublicSpeakerShareActions model={model} />
            ) : null}
            <Button
              type="button"
              size="small"
              onClick={model.closeSpeakerProfile}
            >
              Close speaker details
            </Button>
          </div>
        </div>
      </div>
      {model.showEmbedField("biography") && biography ? (
        <>
          <h3>Biography</h3>
          <p id={biographyId}>
            {model.expandedSpeakerBiography ? biography : biographySnippet}
          </p>
          {biographyIsLong ? (
            <Button
              type="button"
              size="small"
              aria-expanded={model.expandedSpeakerBiography}
              aria-controls={biographyId}
              onClick={model.toggleSpeakerBiography}
            >
              {model.expandedSpeakerBiography ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </>
      ) : null}
      {model.showEmbedField("sessions") ? (
        <>
          <h3>
            Sessions{" "}
            <span className="status info">
              {model.selectedSpeakerAllSessions.length}
            </span>
          </h3>
          <div className="public-speaker-session-list">
            {model.selectedSpeakerAllSessions.length ? (
              model.selectedSpeakerAllSessions.map((session) => (
                <a
                  href={publicSessionDetailPath(
                    model.programme.event.slug,
                    session.id,
                  )}
                  key={session.id}
                >
                  <strong>{session.title}</strong>
                  {model.showEmbedField("time") ? (
                    <span>
                      {formatDay(
                        session.startsAt,
                        model.programme.event.timezone,
                      )}{" "}
                      ·{" "}
                      {formatProgrammeTimeRange(
                        session.startsAt,
                        session.endsAt,
                        model.programme.event.timezone,
                      )}
                    </span>
                  ) : null}
                  {model.showEmbedField("location") ? (
                    <span>{session.room}</span>
                  ) : null}
                </a>
              ))
            ) : (
              <p className="subtle">No published sessions.</p>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

export function PublicSpeakerGallerySurface({
  model,
}: {
  model: PublicProgrammeModel;
}) {
  const publishedCount =
    model.orderedSpeakers?.length ?? model.gallerySpeakers.length;
  const sparse = publishedCount <= SPARSE_SPEAKER_SEARCH;
  const showSearch = !model.embedded && model.showControl("search");
  const pair = model.gallerySpeakers.length <= 2;
  return (
    <section
      className={`public-surface speaker-gallery-surface${pair ? " is-pair" : ""}`}
      aria-labelledby="speaker-gallery-title"
    >
      <SurfaceHeading
        kicker="The people on stage"
        title="Speaker Gallery"
        id="speaker-gallery-title"
        description={
          sparse ? undefined : "Published portraits from this event."
        }
        count={sparse ? undefined : `${model.gallerySpeakers.length} speakers`}
        sparse={sparse}
      >
        {showSearch ? (
          <SpeakerSearchField
            id="speaker-gallery-search"
            value={model.galleryQuery}
            onChange={model.setGalleryQuery}
            label="Search speaker gallery by name"
          />
        ) : null}
      </SurfaceHeading>
      {model.gallerySpeakers.length ? (
        <div className={`speaker-gallery-grid${pair ? " is-pair" : ""}`}>
          {model.gallerySpeakers.map((speaker) => (
            <SpeakerGalleryCard
              key={speaker.id}
              speaker={speaker}
              model={model}
            />
          ))}
        </div>
      ) : (
        <p className="empty">No speakers match this search.</p>
      )}
      {model.selectedSpeaker ? (
        <SpeakerDetailPanel model={model} variant="gallery" />
      ) : null}
    </section>
  );
}
