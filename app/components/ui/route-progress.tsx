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
 * It also announces the page a navigation landed on, because client-side
 * routing moves neither focus nor the accessibility tree's attention.
 */
export function RouteProgress() {
  const navigation = useNavigation();
  const active = navigation.state !== "idle";
  const [visible, setVisible] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const wasActive = useRef(false);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (active) {
      /* The specification budgets cached route transition feedback at 100ms,
         so the bar must appear inside that window. */
      timer.current = window.setTimeout(() => setVisible(true), 90);
    } else {
      setVisible(false);
    }
    return () => window.clearTimeout(timer.current);
  }, [active]);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    /* <Meta> sets the new document title while the destination renders, so it
       is settled by the time this commit's frame runs. */
    const frame = requestAnimationFrame(() =>
      setAnnouncement(document.title || "Page loaded"),
    );
    return () => cancelAnimationFrame(frame);
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
        {active ? "Loading" : announcement}
      </div>
    </>
  );
}
