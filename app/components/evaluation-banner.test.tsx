import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  EvaluationBanner,
  type EvaluationBannerIdentity,
  evaluationBannerHiddenFromCookieHeader,
  evaluationBannerInitiallyHidden,
  evaluationBannerPreferenceCookie,
} from "./evaluation-banner";

const identity: EvaluationBannerIdentity = {
  name: "Jordan Alvarez",
  label: "Event organiser",
};

function render(
  evaluation: EvaluationBannerIdentity | null,
  path = "/admin/command",
) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <EvaluationBanner evaluation={evaluation} />,
      },
    ],
    { initialEntries: [path] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("evaluation banner preference cookie", () => {
  it("treats a missing or visible cookie as the expanded bar", () => {
    expect(evaluationBannerHiddenFromCookieHeader(null)).toBe(false);
    expect(evaluationBannerHiddenFromCookieHeader("")).toBe(false);
    expect(
      evaluationBannerHiddenFromCookieHeader("program_cue_eval_banner=visible"),
    ).toBe(false);
    expect(
      evaluationBannerHiddenFromCookieHeader(
        "program_cue_eval_banner_extra=hidden",
      ),
    ).toBe(false);
  });

  it("reads hidden from a mixed cookie header", () => {
    expect(
      evaluationBannerHiddenFromCookieHeader(
        "program_cue_sidebar=collapsed; program_cue_eval_banner=hidden; other=1",
      ),
    ).toBe(true);
  });

  it("writes a non-HttpOnly path cookie for the preference", () => {
    expect(evaluationBannerPreferenceCookie(true)).toBe(
      "program_cue_eval_banner=hidden; path=/; max-age=31536000; samesite=lax",
    );
    expect(evaluationBannerPreferenceCookie(false)).toBe(
      "program_cue_eval_banner=visible; path=/; max-age=31536000; samesite=lax",
    );
  });

  it("keeps a remount hidden when only the cookie says so", () => {
    expect(evaluationBannerInitiallyHidden(identity, null)).toBe(false);
    expect(
      evaluationBannerInitiallyHidden(
        identity,
        "program_cue_eval_banner=hidden",
      ),
    ).toBe(true);
    expect(
      evaluationBannerInitiallyHidden(
        { ...identity, bannerHidden: true },
        "program_cue_eval_banner=visible",
      ),
    ).toBe(true);
  });
});

describe("evaluation banner", () => {
  it("names the persona and offers hide, guide and persona-change actions", () => {
    const markup = render(identity);

    expect(markup).toContain('aria-label="Evaluation session"');
    expect(markup).toContain(
      "Evaluation:</strong> Event organiser · Jordan Alvarez",
    );
    expect(markup).toContain("Hide evaluation bar");
    expect(markup).toContain('href="/evaluate"');
    expect(markup).toContain("Change persona");
    expect(markup).not.toContain("Show evaluation bar");
  });

  it("collapses to a restore control that keeps the persona name", () => {
    const markup = render({ ...identity, bannerHidden: true });

    expect(markup).toContain('aria-label="Evaluation session"');
    expect(markup).toContain(
      "Show evaluation bar: Evaluation · Jordan Alvarez",
    );
    expect(markup).toContain("Evaluation · Jordan Alvarez");
    expect(markup).not.toContain("Change persona");
    expect(markup).not.toContain("Hide evaluation bar");
  });

  it("does not render evaluation chrome inside embeds", () => {
    expect(render(identity, "/embed/programme/future-of-events-2027")).toBe("");
    expect(
      render(
        { ...identity, bannerHidden: true },
        "/embed/programme/future-of-events-2027",
      ),
    ).toBe("");
  });

  it("renders nothing without an evaluation session", () => {
    expect(render(null)).toBe("");
  });
});
