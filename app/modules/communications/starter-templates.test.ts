import { describe, expect, it } from "vitest";

import { saveTemplateSchema } from "./communication-schema";
import {
  assertMergeAudienceCompatible,
  assertNoUnresolvedTemplateContent,
} from "./communication-service-shared";
import {
  mergeTemplateVariables,
  renderMergeTemplate,
  representativeMergeValues,
} from "./merge-template";
import { isStarterWording, STARTER_TEMPLATES } from "./starter-templates";

const address = "100 Programme Way, Toronto, ON M5V 2W6";

describe("starter email templates", () => {
  it("covers the submission confirmation and the decision once each", () => {
    expect(STARTER_TEMPLATES.map((starter) => starter.category)).toEqual([
      "submission_confirmation",
      "decision",
    ]);
  });

  for (const starter of STARTER_TEMPLATES) {
    it(`${starter.name} passes the same checks as an organiser's template`, () => {
      const template = saveTemplateSchema.parse({
        name: starter.name,
        category: starter.category,
        subject: starter.subject,
        content: { body: starter.body, physicalAddress: address },
      });
      // Parsing trims; stored starter text must already be in that form.
      expect(template.subject).toBe(starter.subject);
      expect(template.content.body).toBe(starter.body);
      expect(() => assertNoUnresolvedTemplateContent(template)).not.toThrow();
      expect(() =>
        assertMergeAudienceCompatible(
          template,
          starter.category === "decision"
            ? "decision_recipients"
            : "submitted_applicants",
        ),
      ).not.toThrow();
      expect(() =>
        renderMergeTemplate(
          `${starter.subject}\n${starter.body}`,
          representativeMergeValues,
        ),
      ).not.toThrow();
    });
  }

  it("reads naturally for every decision outcome", () => {
    const decision = STARTER_TEMPLATES[1];
    for (const outcome of ["accepted", "waitlisted", "rejected"]) {
      expect(
        renderMergeTemplate(decision.body, {
          ...representativeMergeValues,
          "decision.outcome": outcome,
        }),
      ).toContain(`your proposal has been ${outcome}.`);
    }
  });

  it("never sends the internal decision rationale", () => {
    const decision = STARTER_TEMPLATES[1];
    expect(
      mergeTemplateVariables(`${decision.subject}\n${decision.body}`),
    ).not.toContain("decision.rationale");
  });

  it("recognises starter wording only until the subject or body changes", () => {
    const [confirmation] = STARTER_TEMPLATES;
    expect(isStarterWording(confirmation)).toBe(true);
    expect(
      isStarterWording({ ...confirmation, subject: "We have your proposal" }),
    ).toBe(false);
    expect(
      isStarterWording({
        ...confirmation,
        body: `${confirmation.body} Thanks.`,
      }),
    ).toBe(false);
    expect(isStarterWording({ ...confirmation, category: "decision" })).toBe(
      false,
    );
  });
});
