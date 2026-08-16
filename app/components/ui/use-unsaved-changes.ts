import { useCallback } from "react";
import { useBeforeUnload, useBlocker } from "react-router";

export function useUnsavedChanges(dirty: boolean) {
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) event.preventDefault();
      },
      [dirty],
    ),
  );
  return useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
}
