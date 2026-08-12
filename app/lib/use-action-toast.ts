import { useEffect, useRef } from "react";
import { toast } from "sonner";

export type ActionResult = {
  ok?: boolean;
  message?: string;
  /** The work committed but reported a caveat. Not a failure. */
  committed?: boolean;
};

/**
 * One feedback rule for the whole product:
 *   result stays on the page   -> inline StatusNotice
 *   result crosses a navigation -> toast
 *
 * This covers the second case. Routes already return { ok, message }, so
 * adopting it is one line per route. Fires once per submission: React Router
 * hands back the same object until the next one.
 */
export function useActionToast(actionData: ActionResult | undefined | null) {
  const reported = useRef<ActionResult | null>(null);

  useEffect(() => {
    if (!actionData || actionData === reported.current) return;
    reported.current = actionData;

    const { message, ok, committed } = actionData;
    if (!message) return;

    if (ok) toast.success(message);
    else if (committed) toast.warning(message);
    else toast.error(message);
  }, [actionData]);
}
