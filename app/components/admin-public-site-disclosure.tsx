import type { ReactNode } from "react";

export function SiteRailDisclosure({
  title,
  preview,
  help,
  children,
}: {
  title: string;
  preview: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <details className="public-site-rail-section public-site-rail-disclosure">
      <summary>
        <h2 className="public-site-rail-title">
          <span>{title}</span>
          <span className="help public-site-rail-help">{preview}</span>
        </h2>
      </summary>
      {help ? <p className="help">{help}</p> : null}
      {children}
    </details>
  );
}
