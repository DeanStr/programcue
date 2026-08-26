import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  Button,
  ButtonAnchor,
  ButtonLink,
  ButtonSummary,
  IconButtonAnchor,
} from "./button";

describe("Button", () => {
  it("announces and disables pending work without dropping its label", () => {
    const markup = renderToStaticMarkup(
      <Button pending pendingLabel="Saving">
        Save changes
      </Button>,
    );

    expect(markup).toContain("Saving");
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('type="button"');
  });

  it("preserves an explicit busy state when pending rendering is not active", () => {
    const markup = renderToStaticMarkup(
      <Button aria-busy="true">Refresh status</Button>,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("disabled");
  });

  it("keeps navigational actions as real links", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ButtonLink to="/event" variant="primary" size="small">
              Open event
            </ButtonLink>
          ),
        },
        { path: "/event", element: <div>Event</div> },
      ],
      { initialEntries: ["/"] },
    );
    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('href="/event"');
    expect(markup).toContain('class="btn primary small"');
    expect(markup).not.toContain("<button");
  });

  it("keeps external actions as anchors", () => {
    const markup = renderToStaticMarkup(
      <ButtonAnchor href="https://example.com" size="small">
        Provider site
      </ButtonAnchor>,
    );

    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('class="btn small"');
    expect(markup).not.toContain("<button");
  });

  it("keeps icon-only downloads as named anchors", () => {
    const markup = renderToStaticMarkup(
      <IconButtonAnchor href="/download" aria-label="Download file">
        Download glyph
      </IconButtonAnchor>,
    );

    expect(markup).toContain('href="/download"');
    expect(markup).toContain('aria-label="Download file"');
    expect(markup).toContain('class="icon-btn"');
    expect(markup).not.toContain("<button");
  });

  it("keeps disclosure actions as summary elements", () => {
    const markup = renderToStaticMarkup(
      <details>
        <ButtonSummary variant="danger" size="small" className="mt">
          Reopen decision
        </ButtonSummary>
      </details>,
    );

    expect(markup).toContain('<summary class="btn danger small mt">');
    expect(markup).not.toContain("<button");
  });
});
