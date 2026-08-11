import ical, { ICalCalendarMethod, ICalEventStatus } from "ical-generator";

import type { CalendarMethod, CalendarProviderName, CalendarQueueMessage } from "./calendar-schema";

export type CalendarPayload = {
  uid: string;
  sequence: number;
  method: CalendarMethod;
  title: string;
  description: string;
  location: string;
  startsAt: number;
  endsAt: number;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  attendeeEmail: string;
};

export function stableCalendarUid(eventId: string, sessionId: string, personId: string) {
  const local = `${eventId}.${sessionId}.${personId}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${local}@calendar.programcue.app`;
}

export function generateInvitationIcs(payload: CalendarPayload) {
  if (!Number.isInteger(payload.sequence) || payload.sequence < 0) throw new Error("Calendar sequence must be a non-negative integer.");
  if (payload.endsAt <= payload.startsAt) throw new Error("Calendar invitation end must be after its start.");
  const calendar = ical({
    name: "Program Cue",
    prodId: { company: "Program Cue", product: "Program Cue", language: "EN" },
  });
  calendar.method(payload.method === "CANCEL" ? ICalCalendarMethod.CANCEL : ICalCalendarMethod.REQUEST);
  calendar.createEvent({
    id: payload.uid,
    sequence: payload.sequence,
    start: new Date(payload.startsAt * 1_000),
    end: new Date(payload.endsAt * 1_000),
    summary: payload.title,
    description: payload.description,
    location: payload.location,
    organizer: { name: payload.organizerName, email: payload.organizerEmail },
    attendees: [{ name: payload.attendeeName, email: payload.attendeeEmail, rsvp: true }],
    status: payload.method === "CANCEL" ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
    stamp: new Date(),
  });
  return calendar.toString();
}

export async function hashCalendarPayload(payload: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash the durable lifecycle fields rather than the rendered ICS document.
 * ical-generator includes a generated DTSTAMP, so rendered output is not a
 * stable value to compare when a Queue message is consumed later.
 */
export function hashCalendarLifecyclePayload(
  provider: CalendarProviderName,
  payload: CalendarQueueMessage["payload"],
) {
  return hashCalendarPayload(JSON.stringify({
    provider,
    uid: payload.uid,
    sequence: payload.sequence,
    method: payload.method,
    title: payload.title,
    description: payload.description,
    location: payload.location,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    timezone: payload.timezone,
    attendeeName: payload.attendeeName,
    attendeeEmail: payload.attendeeEmail,
    organizerName: payload.organizerName,
    organizerEmail: payload.organizerEmail,
    brandAccent: payload.brandAccent,
  }));
}
