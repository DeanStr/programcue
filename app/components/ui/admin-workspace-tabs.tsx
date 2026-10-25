import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { cn } from "~/lib/cn";

export type AdminWorkspacePanel<Panel extends string> = {
  id: Panel;
  label: string;
  meta?: ReactNode;
};

export function AdminWorkspaceTabs<Panel extends string>({
  label,
  panels,
  activePanel,
  onChange,
  className,
}: {
  label: string;
  panels: readonly AdminWorkspacePanel<Panel>[];
  activePanel: Panel;
  onChange(panel: Panel): void;
  className?: string;
}) {
  const navigationId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const bounds = list.getBoundingClientRect();
      const before =
        (list.firstElementChild?.getBoundingClientRect().left ?? bounds.left) <
        bounds.left - 1;
      const after =
        (list.lastElementChild?.getBoundingClientRect().right ?? bounds.right) >
        bounds.right + 1;
      setEdges((current) =>
        current.before === before && current.after === after
          ? current
          : { before, after },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (let index = 0; index < panels.length; index++) {
      const item = list.children[index];
      if (item) observer.observe(item);
    }
    list.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, [panels]);

  const revealView = (direction: "before" | "after") => {
    const list = listRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const items = [...list.querySelectorAll<HTMLButtonElement>("button")];
    const target =
      direction === "after"
        ? items.find(
            (item) => item.getBoundingClientRect().right > bounds.right - 28,
          )
        : items
            .reverse()
            .find(
              (item) => item.getBoundingClientRect().left < bounds.left + 28,
            );
    // Move focus off the arrow before it disappears at the end of the list.
    // Revealing a view leaves activation to the user.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <nav
      className={cn("pc-workspace-tabs", className)}
      aria-label={label}
      id={navigationId}
      data-scroll-before={edges.before || undefined}
      data-scroll-after={edges.after || undefined}
    >
      {edges.before ? (
        <button
          className="pc-workspace-tabs-scroll is-previous"
          type="button"
          aria-label="Show previous views"
          aria-controls={`${navigationId}-list`}
          onClick={() => revealView("before")}
        >
          <ChevronLeft aria-hidden size={18} />
        </button>
      ) : null}
      <ul ref={listRef} id={`${navigationId}-list`}>
        {panels.map((panel) => (
          <li key={panel.id}>
            <button
              type="button"
              aria-pressed={activePanel === panel.id}
              onClick={() => onChange(panel.id)}
            >
              <span>{panel.label}</span>
              {panel.meta === undefined ? null : (
                <span className="pc-workspace-tab-meta">{panel.meta}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {edges.after ? (
        <button
          className="pc-workspace-tabs-scroll is-next"
          type="button"
          aria-label="Show more views"
          aria-controls={`${navigationId}-list`}
          onClick={() => revealView("after")}
        >
          <ChevronRight aria-hidden size={18} />
        </button>
      ) : null}
    </nav>
  );
}
