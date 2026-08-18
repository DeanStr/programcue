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
        <div>
          <h2 className="public-site-rail-title">{title}</h2>
          <p className="help public-site-rail-help">{preview}</p>
        </div>
      </summary>
      {help ? <p className="help">{help}</p> : null}
      {children}
    </details>
  );
}
