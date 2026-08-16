import { useEffect, useState } from "react";

import type { AutoPlacementPreview } from "~/modules/schedule/schedule-auto-placement";
import {
  autoPlacementResponseError,
  isAutoPlacementConfirmation,
  isAutoPlacementPreview,
  isRecord,
  type AutoPlacementResultNotice,
} from "./schedule-planner-workspace-helpers";

export function useScheduleAutoPlacement(result: unknown) {
  const [preview, setPreview] = useState<AutoPlacementPreview | null>(null);
  const [outcome, setOutcome] = useState<AutoPlacementResultNotice | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A confirmation consumes the preview from the render in which the new server result arrived; preview updates must not replay that result.
  useEffect(() => {
    if (result === undefined) return;
    if (!isRecord(result)) {
      setPreview(null);
      setOutcome(null);
      setError(
        "Auto-place returned an invalid response. Refresh and try again.",
      );
      return;
    }
    if (result.intent === "auto-place-preview") {
      if (isAutoPlacementPreview(result.autoPreview)) {
        setPreview(result.autoPreview);
        setOutcome(null);
        setError(null);
      } else {
        setPreview(null);
        setOutcome(null);
        setError(autoPlacementResponseError(result));
      }
      return;
    }
    if (result.intent === "auto-place-confirm") {
      if (isAutoPlacementConfirmation(result)) {
        setOutcome({
          appliedCount: result.appliedCount,
          excludedCount: result.excludedCount,
          unplacedCount: result.unplacedCount,
          unplaced: preview?.unplaced ?? [],
          warning: result.warning,
        });
        setPreview(null);
        setError(null);
      } else {
        setPreview(null);
        setOutcome(null);
        setError(autoPlacementResponseError(result));
      }
      return;
    }
    setPreview(null);
    setOutcome(null);
    setError(autoPlacementResponseError(result));
  }, [result]);

  return {
    preview,
    outcome,
    error,
    clearError: () => setError(null),
    clearFeedback: () => {
      setError(null);
      setOutcome(null);
    },
    dismissPreview: () => setPreview(null),
  };
}
