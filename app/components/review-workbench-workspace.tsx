import {
  ReviewWorkbenchModelContext,
  type ReviewWorkbenchWorkspaceProps,
  useReviewWorkbenchModel,
  useReviewWorkbenchState,
} from "~/components/review-workbench-model";
import { ReviewerShell } from "~/components/reviewer-shell";
import {
  ReviewActionNotice,
  ReviewConflictDialog,
  ReviewDraftConflictNotice,
  ReviewDraftRecoveryNotice,
  ReviewShortcutSheet,
  ReviewSubmitDialog,
  ReviewWorkbenchHeader,
} from "./review-workbench-dialogs";
import { ReviewWorkspaceState } from "./review-workbench-score-panel";

export {
  reviewCanAdoptServerPayload,
  reviewSaveCoversCurrentEdits,
} from "~/components/review-workbench-model";

function ReviewWorkbenchPage() {
  const { viewer, eventName } = useReviewWorkbenchModel();
  return (
    <ReviewerShell viewer={viewer} eventName={eventName}>
      <ReviewWorkbenchHeader />
      <ReviewDraftRecoveryNotice />
      <ReviewActionNotice />
      <ReviewWorkspaceState />
      <ReviewShortcutSheet />
      <ReviewSubmitDialog />
      <ReviewDraftConflictNotice />
      <ReviewConflictDialog />
    </ReviewerShell>
  );
}

export function ReviewWorkbenchWorkspace(props: ReviewWorkbenchWorkspaceProps) {
  const model = useReviewWorkbenchState(props);
  return (
    <ReviewWorkbenchModelContext.Provider value={model}>
      <ReviewWorkbenchPage />
    </ReviewWorkbenchModelContext.Provider>
  );
}
