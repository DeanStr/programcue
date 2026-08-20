import { type ReactNode, useId } from "react";

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
  return (
    <nav
      className={cn("pc-workspace-tabs", className)}
      aria-label={label}
      id={navigationId}
    >
      <ul>
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
    </nav>
  );
}
