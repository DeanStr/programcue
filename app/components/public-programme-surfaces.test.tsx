import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  PublishedProgramme,
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import {
  PublicAgendaSurface,
  PublicSpeakerGallerySurface,
} from "./public-programme-surfaces";
import {
  PublicSpeakerAvatar,
  SaveSessionButton,
} from "./public-programme-parts";
import {
  sessionSpeakerDetails,
  speakerAffiliation,
  type PublicProgrammeModel,
} from "./public-programme-model";

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
  event: { slug: "future-of-events-2027", timezone: "America/Toronto" },
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
    ...overrides,
  } as unknown as PublicProgrammeModel;
}

describe("public programme speaker surfaces", () => {
  it("exposes an explicit agenda detail close action", () => {
    const agendaProgramme = {
      ...programme,
      sessions: [session],
      speakers: [speaker],
    } as PublishedProgramme;
    const markup = renderToStaticMarkup(
      <PublicAgendaSurface
        model={model({
          programme: agendaProgramme,
          day: "All days",
          days: ["Tuesday, May 20"],
          visible: [session],
          selected: session,
          setSelectedId: vi.fn(),
          speakerById: new Map([[speaker.id, speaker]]),
        })}
      />,
    );

    expect(markup).toContain("Close session details");
    expect(markup).toContain('aria-controls="public-session-detail"');
    expect(markup).toContain('aria-expanded="true"');
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
    expect(markup).toContain('type="search"');
    expect(markup).toContain("Search speaker gallery by name");
    expect(markup).toContain("Open speaker details for Priya Shah");
    expect(markup).toContain("Director of Experience Design");
    expect(markup).toContain("EventLab");
    expect(markup).toContain("/images/demo-speakers/priya-shah.webp");
    expect(markup).toContain('loading="lazy"');
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
      'href="/public/programme/future-of-events-2027#session-future-attendee-engagement"',
    );
  });

  it("fails fast when a session speaker name is missing or stale", () => {
    const speakerById = new Map([[speaker.id, speaker]]);

    expect(() =>
      sessionSpeakerDetails({ ...session, speakerNames: [] }, speakerById),
    ).toThrow(/missing or stale name/iu);
    expect(() =>
      sessionSpeakerDetails(
        { ...session, speakerNames: ["Another Name"] },
        speakerById,
      ),
    ).toThrow(/missing or stale name/iu);
  });
});
