import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusNotice } from "./status-notice";

describe("StatusNotice", () => {
  it("names its live region from the visible title", () => {
    const markup = renderToStaticMarkup(
      <StatusNotice tone="success" title="Provider ready">
        Delivery may now be confirmed.
      </StatusNotice>,
    );
    const labelledBy = markup.match(/aria-labelledby="([^"]+)"/)?.[1];

    expect(markup).toContain('role="status"');
    expect(labelledBy).toBeTruthy();
    expect(markup).toContain(
      `<strong id="${labelledBy}">Provider ready</strong>`,
    );
  });

  it("uses an alert only for blocking feedback", () => {
    const markup = renderToStaticMarkup(
      <StatusNotice tone="danger" title="Delivery blocked" />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
  });
});
