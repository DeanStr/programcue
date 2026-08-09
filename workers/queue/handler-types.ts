import type { DirectCalendarProvider } from "../../app/modules/calendars/calendar-providers.server";
import type { ResendEmailProvider } from "../../app/modules/communications/resend.server";

export type QueueProviderDependencies = {
  resend?: ResendEmailProvider;
  directCalendar?: DirectCalendarProvider;
};
