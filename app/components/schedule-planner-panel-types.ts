import type { Dispatch, SetStateAction } from "react";
import type { useFetcher } from "react-router";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import type { action, loader } from "~/routes/schedule-planner.server";

export type SchedulePlannerWorkspaceData = Awaited<ReturnType<typeof loader>>;
export type ScheduleEntry = ScheduleWorkspace["entries"][number];
export type ScheduleView = "room" | "list" | "day" | "week" | "track";
export type ScheduleFetcher = ReturnType<typeof useFetcher<typeof action>>;
export type StateSetter<T> = Dispatch<SetStateAction<T>>;
