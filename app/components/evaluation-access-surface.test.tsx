import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import {
  EvaluationAccessSurface,
  type EvaluationAccessSurfaceProps,
  type EvaluationPersonaCard,
} from "./evaluation-access-surface";

const identities: EvaluationPersonaCard[] = [
  {
    key: "organizer",
    label: "Event organiser",
    name: "Jordan Alvarez",
    description: "The complete operations workspace with a rich event.",
    destination: "/admin/command",
    whatToTry: "Inspect submissions and scheduling.",
    group: "showcase",
    requiresAccountActivation: false,
  },
  {
    key: "sbek_applicant",
    label: "Clean applicant",
    name: "Priya Raman",
    description: "The exact clean starting identity.",
    destination: "/apply/form",
    whatToTry: "Start an application and submit it.",
    group: "scenario",
    requiresAccountActivation: true,
  },
  {
    key: "sbek_reviewer",
    label: "Clean invited reviewer",
    name: "Sam Whitfield",
    description: "The fixed reviewer identity before any assignment.",
    destination: "/events/select",
    whatToTry: "Accept access after the organiser invites this reviewer.",
    group: "scenario",
    requiresAccountActivation: false,
  },
];

function render(overrides: Partial<EvaluationAccessSurfaceProps> = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/evaluate",
        element: (
          <EvaluationAccessSurface
            busy={false}
            eventName="Future of Events 2027"
            identities={identities}
            resetBusy={false}
            selected={null}
            unlocked
            {...overrides}
          />
        ),
      },
    ],
    { initialEntries: ["/evaluate"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("evaluation access gate", () => {
  it("masks the access code and offers a labelled reveal control", () => {
    const markup = render({ unlocked: false });

    expect(markup).toContain('name="accessCode"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('aria-label="Show access code"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("Unlock evaluation");
    // No persona board leaks through the gate.
    expect(markup).not.toContain("Showcase personas");
    expect(markup).not.toContain("Reset evaluation data");
  });

  it("links the public output from the gate, before any code is entered", () => {
    const markup = render({ unlocked: false });

    for (const href of [
      "/public/programme/future-of-events-2027",
      "/public/programme/future-of-events-2027/schedule",
      "/public/programme/future-of-events-2027/gallery",
      "/apply/form",
      "/api/docs",
    ]) {
      expect(markup).toContain(`href="${href}"`);
    }
  });

  it("distinguishes populated showcases from clean scenario identities", () => {
    const markup = render({ unlocked: false });

    expect(markup).toContain("Populated showcase roles open on");
    expect(markup).toContain(
      "Clean scenario identities start before access or work is created",
    );
  });

  it("reports an invalid code as an alert that takes focus", () => {
    const markup = render({
      unlocked: false,
      actionData: {
        ok: false,
        message: "That evaluation access code is not valid.",
      },
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("That evaluation access code is not valid.");
  });
});

describe("evaluation persona board", () => {
  it("keeps the persona labels the evaluator instructions name", () => {
    const markup = render();

    expect(markup).toContain("Showcase personas");
    expect(markup).toContain("Open as Event organiser");
    expect(markup).toContain("Create evaluator submitter account");
    expect(markup).toContain("Activate account and choose event");
    expect(markup).toContain("Clean invited reviewer");
    expect(markup).toContain("Lock evaluation");
    expect(markup).toContain("Reset evaluation data");
  });

  it("explains that locking affects this browser but not shared data", () => {
    const markup = render();

    expect(markup).toContain('aria-describedby="evaluation-lock-help"');
    expect(markup).toContain(
      "Requires the access code again on this browser. Shared data is unchanged.",
    );
  });

  it("submits each persona with its own intent and identity", () => {
    const markup = render();

    expect(markup).toContain('value="select_identity"');
    expect(markup).toContain('value="activate_account"');
    expect(markup).toContain('value="activate_account_and_choose_event"');
    expect(markup).toContain('value="organizer"');
    expect(markup).toContain('value="sbek_applicant"');
  });

  it("states that the clean reviewer has no event access yet", () => {
    const markup = render();

    expect(markup).toContain("No event access yet, by design.");
    expect(markup).toContain(
      "The organiser has to invite this reviewer and the reviewer has to accept",
    );
  });

  it("offers no way back into a workspace until a persona is chosen", () => {
    const markup = render();

    expect(markup).toContain("No persona selected");
    expect(markup).not.toContain("Continue as");
    expect(markup).toContain(
      "opening one without a persona returns you to this page",
    );
  });

  it("names the current persona and links straight back to its destination", () => {
    const markup = render({
      selected: {
        identityKey: "organizer",
        name: "Jordan Alvarez",
        label: "Event organiser",
        destination: "/admin/command",
      },
    });

    expect(markup).toContain(
      "Current persona: Event organiser · Jordan Alvarez",
    );
    expect(markup).toContain('href="/admin/command"');
    expect(markup).toContain("Continue as Jordan Alvarez");
    expect(markup).toContain("Current</span>");
  });

  it("does not promise account-free switching where an activation step exists", () => {
    const markup = render();

    expect(markup).toContain(
      "Switching between showcase personas never creates an account",
    );
    expect(markup).toContain("the clean applicant has one explicit, audited");
  });

  it("does not claim that an outbound message was delivered", () => {
    const markup = render();

    expect(markup).toContain("Outbound email workflows are available to test");
    expect(markup).toContain("A send can still fail or bounce");
    expect(markup).not.toContain("Outbound email delivery is live");
  });

  it("arms the reset only once the exact event name is typed", () => {
    const markup = render();

    // Server-rendered with an empty confirmation, so the control starts off.
    expect(markup).toContain("Reset evaluation data</button>");
    expect(markup).toMatch(/<button class="btn danger" disabled=""/u);
    expect(markup).toContain('name="confirmation"');
    expect(markup).toContain(
      '<span class="pc-eval-phrase">Future of Events 2027</span>',
    );
  });

  it("reports a completed reset as a status message", () => {
    const markup = render({
      actionData: {
        ok: true,
        message: "Evaluation data reset. Choose a fresh starting persona.",
      },
    });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      "Evaluation data reset. Choose a fresh starting persona.",
    );
    expect(markup).toMatch(/id="evaluation-reset-confirmation"[^>]*value=""/u);
    expect(markup).toMatch(/<button class="btn danger" disabled=""/u);
  });

  it("disables every persona control while a submission is in flight", () => {
    const markup = render({ busy: true, resetBusy: true });

    expect(markup).toContain("Resetting evaluation data…");
    expect(markup).not.toMatch(
      /<button class="btn primary" type="submit">Open as/u,
    );
  });
});
