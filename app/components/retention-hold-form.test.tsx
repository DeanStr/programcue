import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { RetentionHoldForm, retentionHoldFormKey } from "./retention-hold-form";

function render(holdAt: number | null) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RetentionHoldForm busy={false} holdAt={holdAt} />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("retention hold form", () => {
  it("uses a new instance when the hold state changes", () => {
    expect(retentionHoldFormKey(null)).toBe("none");
    expect(retentionHoldFormKey(1_700_000_000)).toBe("1700000000");
    expect(retentionHoldFormKey(null)).not.toBe(
      retentionHoldFormKey(1_700_000_000),
    );
  });

  it("starts disabled until the owner confirms the current action", () => {
    const place = render(null);
    expect(place).toContain("Place retention hold");
    expect(place).toContain("disabled");
    expect(place).toContain('value="place-hold"');

    const release = render(1_700_000_000);
    expect(release).toContain("Release retention hold");
    expect(release).toContain("disabled");
    expect(release).toContain('value="release-hold"');
  });
});
