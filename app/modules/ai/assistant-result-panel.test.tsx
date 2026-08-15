import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ContextualAiResultPanel } from "./assistant-result-panel";
import type { ContextualAiResult } from "./ai-types";

const attribution = {
  provider: "Workers AI" as const,
  model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  responseId: "response-readiness-test",
  generatedAt: "2026-08-15T10:42:00.000Z",
  advisory: true as const,
};

describe("contextual AI result panel", () => {
  it("renders a readiness advisory as native actions without exposing raw model markup", () => {
    const result: ContextualAiResult = {
      kind: "readiness_summary",
      title: "AI readiness summary",
      content: "**Raw model table** | should not render",
      attribution,
      advisory: true,
      readiness: {
        generatedAt: "2026-08-15T10:42:00.000Z",
        percentage: 73,
        status: "at_risk",
        declaredBlockers: 2,
        summary: "Two recorded blockers need administrator attention.",
        priorities: [
          {
            blockerKey: "critical_tasks",
            label: "Critical tasks incomplete",
            count: 2,
            severity: "danger",
            detail: "Declared critical work is not complete.",
            href: "/admin/tasks?impact=critical&state=open",
            action: "Resolve critical work",
            rationale:
              "These tasks carry the highest recorded impact in the supplied snapshot.",
          },
        ],
        uncertainties: [
          "The snapshot does not quantify dependencies between blocker groups.",
        ],
      },
      evidence: [
        {
          id: "event-readiness",
          label: "Event readiness",
          detail: "73% · at risk",
          href: "/admin/command",
          source: "Program Cue D1",
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ContextualAiResultPanel result={result} />
      </MemoryRouter>,
    );

    expect(markup).toContain("73% · at risk");
    expect(markup).toContain("Recommended next actions");
    expect(markup).toContain("Critical tasks incomplete");
    expect(markup).toContain("Critical · 2 affected");
    expect(markup).toContain("Declared critical work is not complete.");
    expect(markup).toContain("Why AI ranked this:");
    expect(markup).toContain("Resolve critical work");
    expect(markup).toContain("Sources inspected (1)");
    expect(markup).not.toContain("Raw model table");
    expect(markup).not.toContain("Inspected evidence</h3>");
  });

  it("fails fast when a readiness result is missing its validated advisory", () => {
    const result: ContextualAiResult = {
      kind: "readiness_summary",
      title: "AI readiness summary",
      content: "Unvalidated output",
      attribution,
      advisory: true,
      evidence: [],
    };

    expect(() =>
      renderToStaticMarkup(
        <MemoryRouter>
          <ContextualAiResultPanel result={result} />
        </MemoryRouter>,
      ),
    ).toThrow(/missing its validated structured advisory/u);
  });
});
