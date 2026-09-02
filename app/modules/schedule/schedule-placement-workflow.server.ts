import type { Viewer } from "~/platform/auth/authorize.server";
import { placeScheduleEntry } from "./schedule-place-command.server";
import type {
  ScheduleEventScope,
  SchedulePlacementCommand,
  SchedulePlacementResult,
  ScheduleUnassignmentResult,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { unassignScheduleEntry } from "./schedule-unassign-command.server";
import { undoSchedulePlacement } from "./schedule-undo-command.server";

export class SchedulePlacementWorkflow {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private context() {
    return { env: this.env, getWorkspace: this.dependencies.getWorkspace };
  }

  placeD1(
    viewer: Viewer,
    input: unknown,
    command?: SchedulePlacementCommand,
  ): Promise<SchedulePlacementResult> {
    return placeScheduleEntry(this.context(), viewer, input, command);
  }

  unassignD1(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleUnassignmentResult> {
    return unassignScheduleEntry(this.context(), viewer, input);
  }

  undoD1(viewer: Viewer, input: unknown) {
    return undoSchedulePlacement(this.context(), viewer, input);
  }
}
