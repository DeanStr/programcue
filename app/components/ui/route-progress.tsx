import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

/**
 * Navigation feedback for the whole app.
 *
 * There is no HydrateFallback and no clientLoader anywhere, and admin-layout
 * runs five parallel D1 queries before any admin page renders, so a click
 * previously produced nothing at all until the next page painted. One
 * component here covers every route module and every link navigation.
 *
 * It also announces the destination, because client-side navigation otherwise
 * tells a screen reader nothing.
 */
export function RouteProgress() {
  const navigation = useNavigation();
  const active = navigation.state !== "idle";
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (active) {
      // Below ~120ms a bar reads as a flicker, so fast navigations show nothing.
      timer.current = window.setTimeout(() => setVisible(true), 120);
    } else {
      setVisible(false);
    }
    return () => window.clearTimeout(timer.current);
  }, [active]);

  return (
    <>
      <div
        aria-hidden
        className="pc-route-progress"
        data-active={visible ? "true" : "false"}
      >
        <span />
      </div>
      <div aria-live="polite" className="sr-only">
        {active ? "Loading page" : ""}
      </div>
    </>
  );
}
