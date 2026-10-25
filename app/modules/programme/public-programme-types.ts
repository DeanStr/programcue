export type PublishedSession = {
  id: string;
  slug: string;
  title: string;
  description: string;
  /** Stored format key: filters, embeds and category styling use it. */
  format: string;
  /** The event's configured label for `format`; what readers see. */
  formatLabel: string;
  startsAt: number;
  endsAt: number;
  room: string;
  building: string | null;
  level: string | null;
  track: string | null;
  speakerIds: string[];
  speakerNames: string[];
};

/** A published session as a repository reads it, before labels are applied. */
export type PublishedSessionRecord = Omit<PublishedSession, "formatLabel">;

export type PublishedSpeaker = {
  id: string;
  displayName: string;
  imageUrl: string | null;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  sessionIds: string[];
};

export type PublishedSpeakerPreview = Pick<
  PublishedSpeaker,
  "id" | "displayName" | "imageUrl" | "organisationName" | "jobTitle"
>;

export type PublishedProgrammeVersion = {
  eventId: string;
  slug: string;
  version: { id: string; versionNumber: number; publishedAt: number };
};

export type PublishedProgramme = {
  event: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    startDate: string;
    endDate: string;
    venue: string | null;
    venueAddress: string | null;
    venueMapUrl: string | null;
    city: string | null;
    description: string | null;
    brandAccent: string;
    heroImageUrl: string | null;
    logoUrl: string | null;
    bannerUrl: string | null;
    supportUrl: string | null;
    application: {
      url: string;
      state: "accepting" | "not_open" | "closed" | "full";
    } | null;
  };
  version: { id: string; versionNumber: number; publishedAt: number };
  sessions: PublishedSession[];
  speakers: PublishedSpeaker[];
  freshness:
    | {
        source: "d1";
        fetchedAt: number;
        cacheExpiresAt: null;
        cached: false;
      }
    | {
        source: "airtable";
        fetchedAt: number;
        cacheExpiresAt: number;
        cached: boolean;
      };
  /** Hash of every public representation input, including freshness data. */
  contentRevision: string;
};
