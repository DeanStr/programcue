import type { Viewer } from "~/platform/auth/authorize.server";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { EvaluationAdminWorkspaceReader } from "./evaluation-admin-workspace-reader.server";

export class EvaluationPlanWorkspaceWorkflow extends EvaluationServiceFoundation {
  async getAdminWorkspace(viewer: Viewer) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    return this.readAuthoritative(viewer, () =>
      new EvaluationAdminWorkspaceReader(this.env).read(viewer),
    );
  }
}
