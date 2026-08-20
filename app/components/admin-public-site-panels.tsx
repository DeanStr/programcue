import type { ReactNode } from "react";

/* One heading treatment for every editor panel, so a panel that holds records
   and a panel that holds fields open the same way. */
export function SitePanelHeading({
  title,
  help,
}: {
  title: string;
  help?: string;
}) {
  return (
    <div className="public-site-panel-heading">
      <div>
        <h2 className="public-site-panel-title">{title}</h2>
        {help ? <p className="help">{help}</p> : null}
      </div>
    </div>
  );
}

/* A saved record is a closed line until the organiser opens it. Seven sponsors
   held open as seven six-field forms was most of this page's height, and none
   of it was the record anybody had come to change. */
export function SiteRecordDisclosure({
  title,
  meta,
  state,
  children,
}: {
  title: string;
  meta?: string;
  state?: string;
  children: ReactNode;
}) {
  return (
    <details className="public-site-record-disclosure">
      <summary>
        <span className="public-site-record-summary">
          <strong>{title}</strong>
          {meta ? <span className="help">{meta}</span> : null}
        </span>
        {state ? (
          <span className="public-site-record-state">{state}</span>
        ) : null}
      </summary>
      {children}
    </details>
  );
}
