export const fixedParticipantProfileFields = [
  { key: "name", label: "Display name", formName: "name" },
  { key: "biography", label: "Biography", formName: "biography" },
  {
    key: "pronunciation",
    label: "Name pronunciation",
    formName: "pronunciation",
  },
  {
    key: "organisation_name",
    label: "Organisation",
    formName: "organisationName",
  },
  { key: "job_title", label: "Job title", formName: "jobTitle" },
  {
    key: "linkedin_url",
    label: "LinkedIn profile URL",
    formName: "linkedinUrl",
  },
  { key: "x_handle", label: "X handle", formName: "xHandle" },
  {
    key: "travel_preferences",
    label: "Travel and logistics preferences",
    formName: "travelPreferences",
  },
] as const;

export type FixedParticipantProfileFieldKey =
  (typeof fixedParticipantProfileFields)[number]["key"];
export type ParticipantFieldAccess = "hidden" | "read_only" | "editable";
export type EventFieldOwnerType = "person" | "session";
export type EventFieldType =
  | "short_text"
  | "long_text"
  | "number"
  | "boolean"
  | "date"
  | "single_choice"
  | "multiple_choice";

export type EventFieldDefinitionValue = {
  id: string;
  ownerType: EventFieldOwnerType;
  fieldKey: string;
  label: string;
  fieldType: EventFieldType;
  options: string[];
  participantAccess: ParticipantFieldAccess;
  required: boolean;
  position: number;
  status: "active" | "archived";
  revision: number;
  valueRevision: number;
  value: string | number | boolean | string[] | null;
};
