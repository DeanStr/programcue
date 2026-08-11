import type { DirectCalendarProvider } from "../../app/modules/calendars/calendar-providers.server";
import type { EmailProvider } from "../../app/modules/communications/email-provider";

export type QueueProviderDependencies = {
  email?: EmailProvider;
  directCalendar?: DirectCalendarProvider;
};
