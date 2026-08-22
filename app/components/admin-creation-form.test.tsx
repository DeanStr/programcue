import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { AdminCreationForm } from "~/routes/submissions-admin-panels";

describe("administrator record creation feedback", () => {
  it("associates the speaker error without creating a duplicate live alert", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <AdminCreationForm
            kind="session"
            routingTracks={[{ id: "track-1", name: "Operations" }]}
            sessionFormats={[
              {
                key: "presentation",
                label: "Presentation",
                defaultDurationMinutes: 45,
                position: 0,
              },
            ]}
            idempotencyKey="creation-feedback-test"
            actionResult={{
              ok: false,
              message: "Each speaker must use a different email address",
              fieldErrors: {
                speakers: "Each speaker must use a different email address",
              },
            }}
          />
        ),
      },
    ]);

    const markup = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(markup).toContain(
      'aria-describedby="admin-creation-speakers-error"',
    );
    expect(markup).toContain('id="admin-creation-speakers-error"');
    expect(markup).not.toContain('role="alert"');
  });
});
