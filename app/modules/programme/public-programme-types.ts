export type PublishedSession = {
  id: string;
  slug: string;
  title: string;
  description: string;
  format: string;
  startsAt: number;
  endsAt: number;
  room: string;
  building: string | null;
  level: string | null;
  track: string | null;
  speakerIds: string[];
  speakerNames: string[];
};

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
