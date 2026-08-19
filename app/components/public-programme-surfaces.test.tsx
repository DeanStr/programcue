import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  PublishedProgramme,
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import {
  eventHeroImagePath,
  initials,
  type PublicProgrammeModel,
  sessionSpeakerDetails,
  speakerAffiliation,
} from "./public-programme-model";
import {
  PublicShareActions,
  PublicSpeakerAvatar,
  PublicSpeakerShareActions,
  SaveSessionButton,
} from "./public-programme-parts";
import {
  PublicScheduleSurface,
  PublicSpeakerGallerySurface,
  PublicSpeakersSurface,
  PublicTimetableSurface,
  publicTimetableLayout,
} from "./public-programme-surfaces";

const speaker: PublishedSpeaker = {
  id: "person-priya",
  displayName: "Priya Shah",
  imageUrl: "/images/demo-speakers/priya-shah.webp",
  biography:
    "Priya Shah helps event teams design useful, inclusive technology experiences. Her work brings together service design, accessible interaction patterns and the practical details that help busy conferences feel calm, welcoming and easy to navigate for every attendee.",
  pronunciation: "PREE-yah SHAH",
  organisationName: "EventLab",
  jobTitle: "Director of Experience Design",
  sessionIds: ["session-1"],
};

const session: PublishedSession = {
  id: "session-1",
  slug: "future-attendee-engagement",
  title: "The Future of Attendee Engagement",
  description: "A published session description.",
  format: "keynote",
  startsAt: Date.parse("2025-05-20T13:00:00Z") / 1_000,
  endsAt: Date.parse("2025-05-20T13:45:00Z") / 1_000,
  room: "Main Stage",
  building: null,
  level: null,
  track: "Leadership",
  speakerIds: [speaker.id],
  speakerNames: [speaker.displayName],
};

const programme = {
  event: {
    slug: "future-of-events-2027",
    timezone: "America/Toronto",
    heroImageUrl: null,
    logoUrl: null,
    bannerUrl: null,
  },
} as PublishedProgramme;

function model(overrides: Partial<PublicProgrammeModel> = {}) {
  return {
    programme,
    gallerySpeakers: [speaker],
    galleryQuery: "",
    setGalleryQuery: vi.fn(),
    selectedSpeaker: null,
    selectedSpeakerAllSessions: [],
    speakerProfileRef: { current: null },
    openSpeakerProfile: vi.fn(),
    closeSpeakerProfile: vi.fn(),
    expandedSpeakerBiography: false,
    toggleSpeakerBiography: vi.fn(),
    showControl: () => true,
    showEmbedField: () => true,
    showSpeakerDetails: true,
    ...overrides,
  } as unknown as PublicProgrammeModel;
}

describe("public programme speaker surfaces", () => {
  it("takes speaker initials from graphemes instead of UTF-16 code units", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("😀 Ada")).toBe("A");
    expect(initials("👨‍👩‍👧‍👦 Ada")).toBe("A");
    expect(initials("👨‍👩‍👧‍👦")).toBe("PC");
  });

  it("uses only the authoritative HTTPS programme hero field", () => {
    expect(
      eventHeroImagePath({
        ...programme.event,
        heroImageUrl: "https://images.example.test/programme_(main).webp",
      }),
    ).toBe("https://images.example.test/programme_(main).webp");
    expect(
      eventHeroImagePath({
        ...programme.event,
        heroImageUrl: "https://images.example.test/été programme.webp",
      }),
    ).toBe("https://images.example.test/%C3%A9t%C3%A9%20programme.webp");
    expect(
      eventHeroImagePath({ ...programme.event, heroImageUrl: null }),
    ).toBeNull();
    const invalidWithLegacyField: PublishedProgramme["event"] & {
      heroImagePath: string;
    } = {
      ...programme.event,
      heroImageUrl: "javascript:alert(1)",
      heroImagePath: "/images/legacy.webp",
    };
    expect(() => eventHeroImagePath(invalidWithLegacyField)).toThrow(
      /hero image URL is invalid/iu,
    );
  });

  it("uses the managed banner before the retired hero URL and rejects invalid paths", () => {
    expect(
      eventHeroImagePath({
        ...programme.event,
        heroImageUrl: "https://images.example.test/legacy.jpg",
        bannerUrl: "/public/brand/test-event/banner",
      }),
    ).toBe("/public/brand/test-event/banner");
    expect(() =>
      eventHeroImagePath({
        ...programme.event,
        bannerUrl: "https://unexpected.example/banner.png",
      }),
    ).toThrow(/banner URL is invalid/i);
  });

  it("lays timetable sessions out against exact time and room axes", () => {
    expect(publicTimetableLayout([session], "America/Toronto")).toEqual({
      rangeStartsAt: Date.parse("2025-05-20T13:00:00Z") / 1_000,
      rangeMinutes: 60,
      rooms: ["Main Stage"],
      markers: [
        Date.parse("2025-05-20T13:00:00Z") / 1_000,
        Date.parse("2025-05-20T13:30:00Z") / 1_000,
        Date.parse("2025-05-20T14:00:00Z") / 1_000,
      ],
    });
    expect(publicTimetableLayout([session], "Asia/Kathmandu")).toMatchObject({
      rangeStartsAt: Date.parse("2025-05-20T12:45:00Z") / 1_000,
      rangeMinutes: 60,
      markers: [
        Date.parse("2025-05-20T12:45:00Z") / 1_000,
        Date.parse("2025-05-20T13:15:00Z") / 1_000,
        Date.parse("2025-05-20T13:45:00Z") / 1_000,
      ],
    });
    expect(publicTimetableLayout([], "America/Toronto")).toBeNull();
  });

  it("renders the timetable as a room grid with in-place detail controls", () => {
    const timetableProgramme = {
      ...programme,
      sessions: [session],
      speakers: [speaker],
    } as PublishedProgramme;
    const markup = renderToStaticMarkup(
      <PublicTimetableSurface
        model={model({
          programme: timetableProgramme,
          day: "All days",
          days: ["Tuesday, May 20"],
          visible: [session],
          embedded: true,
          shared: false,
          speakerById: new Map([[speaker.id, speaker]]),
        })}
      />,
    );

    expect(markup).toContain(">Timetable<");
    expect(markup).toContain('aria-label="Tuesday, May 20 timetable"');
    expect(markup).toContain('class="public-timetable-room"');
    expect(markup).toContain("Main Stage");
    expect(markup).toContain('class="session-time"');
    expect(markup).toContain('<span class="sr-only">Room: </span>Main Stage');
    expect(markup).toContain(
      'aria-label="Open details for The Future of Attendee Engagement"',
    );
    expect(markup).not.toContain('aria-haspopup="dialog"');
    expect(markup).toContain(
      "Open a session to see the details included in this timetable.",
    );
    expect(markup).not.toContain(
      "/public/programme/future-of-events-2027/sessions?session=session-1",
    );
  });

  it("keeps plain speaker names in accessible text when details are hidden", () => {
    const timetableProgramme = {
      ...programme,
      sessions: [session],
      speakers: [speaker],
    } as PublishedProgramme;
    const markup = renderToStaticMarkup(
      <PublicTimetableSurface
        model={model({
          programme: timetableProgramme,
          day: "All days",
          days: ["Tuesday, May 20"],
          visible: [session],
          embedded: true,
          shared: false,
          speakerById: new Map([[speaker.id, speaker]]),
          showSpeakerDetails: false,
        })}
      />,
    );

    expect(markup).toContain(
      '<span class="sr-only">Speakers: </span>Priya Shah',
    );
    expect(markup).not.toContain('aria-label="Speakers"');
    expect(markup).not.toContain('class="public-session-speakers"');
  });

  it("renders the day-by-day schedule as rich chronological cards", () => {
    const scheduleProgramme = {
      ...programme,
      sessions: [session],
      speakers: [speaker],
    } as PublishedProgramme;
    const markup = renderToStaticMarkup(
      <PublicScheduleSurface
        model={model({
          programme: scheduleProgramme,
          day: "All days",
          days: ["Tuesday, May 20"],
          visible: [session],
          embedded: true,
          shared: false,
          speakerById: new Map([[speaker.id, speaker]]),
          expandedDescriptions: [],
          toggleDescription: vi.fn(),
        })}
      />,
    );

    expect(markup).toContain(">Day-by-day schedule<");
    expect(markup).toContain(
      "Browse the published programme in chronological order, with the details included in this view.",
    );
    expect(markup).toContain('class="public-itinerary-card"');
    expect(markup).toContain("A published session description.");
    expect(markup).toContain("Director of Experience Design · EventLab");
    expect(markup).not.toContain("Save The Future of Attendee Engagement");
  });

  it("keeps contextual speaker avatars decorative", () => {
    const photoMarkup = renderToStaticMarkup(
      <PublicSpeakerAvatar speaker={speaker} size={32} />,
    );
    const placeholderMarkup = renderToStaticMarkup(
      <PublicSpeakerAvatar
        speaker={{ ...speaker, imageUrl: null }}
        size={32}
      />,
    );

    expect(photoMarkup).toContain('alt=""');
    expect(photoMarkup).not.toContain("headshot");
    expect(placeholderMarkup).toContain('aria-hidden="true"');
    expect(placeholderMarkup).not.toContain('role="img"');
  });

  it("always renders a copy action for a resolved speaker share", () => {
    const markup = renderToStaticMarkup(
      <PublicSpeakerShareActions
        model={model({
          speakerShare: {
            speakerId: speaker.id,
            speakerName: speaker.displayName,
            sessionTitle: session.title,
            description: speaker.biography!,
            url: "https://programcue.test/public/programme/future-of-events-2027?speaker=person-priya",
            text: "Priya Shah is speaking at Future of Events 2027.",
            imageUrl: null,
          },
        })}
      />,
    );

    expect(markup).toContain("Copy profile link");
    expect(markup).not.toContain(">Share profile<");
  });

  it("always renders a copy action for a resolved session share", () => {
    const markup = renderToStaticMarkup(
      <PublicShareActions
        url="https://programcue.test/public/programme/future-of-events-2027/sessions?session=session-1"
        title={`${session.title} · Future of Events 2027`}
        text={`${session.title} is part of Future of Events 2027.`}
        copyLabel="Copy session link"
        shareLabel="Share session"
        resetKey={session.id}
        failedMessage="This browser could not share the session."
      />,
    );

    expect(markup).toContain("Copy session link");
    expect(markup).not.toContain(">Share session<");
  });

  it("renders only supplied affiliation fields and omits empty metadata", () => {
    expect(
      speakerAffiliation({ jobTitle: "Director", organisationName: null }),
    ).toBe("Director");
    expect(
      speakerAffiliation({ jobTitle: null, organisationName: "EventLab" }),
    ).toBe("EventLab");
    expect(speakerAffiliation({ jobTitle: " ", organisationName: null })).toBe(
      "",
    );

    const missingMetadataSpeaker = {
      ...speaker,
      jobTitle: null,
      organisationName: null,
    };
    const markup = renderToStaticMarkup(
      <PublicSpeakerGallerySurface
        model={model({ gallerySpeakers: [missingMetadataSpeaker] })}
      />,
    );
    expect(markup).not.toContain("Job title not provided");
    expect(markup).not.toContain("Company not provided");
    expect(markup).not.toContain("public-speaker-metadata");
  });

  it("keeps first-save controls actionable while describing verification", () => {
    const markup = renderToStaticMarkup(
      <SaveSessionButton
        session={session}
        model={model({
          saved: [],
          loaderData: {
            itineraryVerificationRequired: true,
            turnstileSiteKey: "turnstile-site-key",
          },
          fetcher: { state: "idle" },
          requiresItineraryVerification: () => true,
          toggle: vi.fn(),
        } as unknown as Partial<PublicProgrammeModel>)}
      />,
    );

    expect(markup).not.toContain("disabled");
    expect(markup).toContain('aria-describedby="itinerary-verification-help"');
    expect(markup).toContain("Save The Future of Attendee Engagement");
  });

  it("renders a searchable visual gallery card with released photo metadata", () => {
    const markup = renderToStaticMarkup(
      <PublicSpeakerGallerySurface model={model()} />,
    );

    expect(markup).toContain("Speaker Gallery");
    expect(markup).not.toContain('type="search"');
    expect(markup).not.toContain("Search speaker gallery by name");
    expect(markup).toContain("Open speaker details for Priya Shah");
    expect(markup).toContain("Director of Experience Design");
    expect(markup).toContain("EventLab");
    expect(markup).toContain("/images/demo-speakers/priya-shah.webp");
    expect(markup).toContain('loading="lazy"');
  });

  it("hides speaker search until the published roster is large enough", () => {
    const sparseGallery = renderToStaticMarkup(
      <PublicSpeakerGallerySurface model={model()} />,
    );
    expect(sparseGallery).not.toContain('type="search"');

    const queriedGallery = renderToStaticMarkup(
      <PublicSpeakerGallerySurface model={model({ galleryQuery: "Priya" })} />,
    );
    expect(queriedGallery).toContain('type="search"');
    expect(queriedGallery).toContain("Search speaker gallery by name");

    const crowdedSpeakers = Array.from({ length: 7 }, (_, index) => ({
      ...speaker,
      id: `${speaker.id}-${index}`,
      displayName: `${speaker.displayName} ${index + 1}`,
    }));
    const crowdedGallery = renderToStaticMarkup(
      <PublicSpeakerGallerySurface
        model={model({ gallerySpeakers: crowdedSpeakers })}
      />,
    );
    expect(crowdedGallery).toContain("Search speaker gallery by name");

    const sparseDirectory = renderToStaticMarkup(
      <PublicSpeakersSurface
        model={model({
          directorySpeakers: [speaker],
          directoryQuery: "",
          setDirectoryQuery: vi.fn(),
        })}
      />,
    );
    expect(sparseDirectory).not.toContain("Search speakers by name");
  });

  it("renders speaker surfaces as non-expanding cards when details are hidden", () => {
    const markup = renderToStaticMarkup(
      <PublicSpeakerGallerySurface
        model={model({ showSpeakerDetails: false })}
      />,
    );

    expect(markup).toContain("Priya Shah");
    expect(markup).toContain('class="speaker-gallery-card is-static"');
    expect(markup).not.toContain("Open speaker details");
    expect(markup).not.toContain('type="button"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("EventLab");
    expect(markup).not.toContain("1 session");
    expect(markup).not.toContain("<img");
  });

  it("renders gallery detail biography and every public session field", () => {
    const markup = renderToStaticMarkup(
      <PublicSpeakerGallerySurface
        model={model({
          selectedSpeaker: speaker,
          selectedSpeakerAllSessions: [session],
        })}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Close speaker details");
    expect(markup).toContain("Director of Experience Design");
    expect(markup).toContain("EventLab");
    expect(markup).toContain("Show more");
    expect(markup).toContain("The Future of Attendee Engagement");
    expect(markup).toContain("Main Stage");
    expect(markup).toContain('loading="eager"');
    // Day and clock range, without the redundant year the previous long-form
    // timestamp repeated on every row of every published list.
    expect(markup).toContain("Tuesday, May 20");
    expect(markup).toContain("9:00–9:45 AM");
    expect(markup).toContain(
      'href="/public/programme/future-of-events-2027/sessions?session=session-1"',
    );
  });

  it("rejects a stale published speaker name", () => {
    const speakerById = new Map([[speaker.id, speaker]]);

    expect(() =>
      sessionSpeakerDetails(
        { ...session, speakerNames: ["Another Name"] },
        speakerById,
      ),
    ).toThrow(/missing or stale name/iu);
  });
});
