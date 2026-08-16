import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSetup } from "~/modules/events/event-repository.server";
import { EventRepositoryPanel } from "./event-setup-panels";

const event = {
  repositoryProvider: "d1",
  repositoryFreshness: { source: "d1" },
  repositoryConnection: {
    baseId: "appProgramCue",
    tableName: "Program Cue Rooms",
    status: "connected",
  },
  repositoryLockedAt: null,
  retentionMonths: 24,
} as unknown as EventSetup;

function renderPanel(hasUnsavedChanges: boolean) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EventRepositoryPanel
        event={event}
        onConfigureAirtable={() => undefined}
        onMigrateRepository={() => undefined}
        canManageFileRetention
        hasUnsavedChanges={hasUnsavedChanges}
      />
    </MemoryRouter>,
  );
}

function button(markup: string, label: string) {
  return markup.match(
    new RegExp(`<button[^>]*>${label}[\\s\\S]*?</button>`, "u"),
  )?.[0];
}

describe("Event Setup repository controls", () => {
  it("blocks provider configuration and migration while Event Setup is dirty", () => {
    const markup = renderPanel(true);

    expect(button(markup, "Revalidate")).toContain("disabled");
    expect(button(markup, "Preview handover to")).toContain("disabled");
    expect(markup).toContain(
      "Save or discard your Event Setup edits before changing where event data is held.",
    );
    expect(markup).toContain('href="/admin/files/retention"');
  });

  it("enables repository controls when the persisted form is unchanged", () => {
    const markup = renderPanel(false);

    expect(button(markup, "Revalidate")).not.toContain("disabled");
    expect(button(markup, "Preview handover to")).not.toContain("disabled");
    expect(markup).not.toContain("event-repository-unsaved-help");
  });
});
