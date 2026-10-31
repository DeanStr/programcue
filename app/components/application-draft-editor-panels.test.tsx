import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FormField } from "~/modules/submissions/submission-schema";
import { FieldControl } from "./application-draft-editor-panels";

function field(type: FormField["type"]): FormField {
  return {
    sectionId: "proposal",
    id: `answer_${type}`,
    label: `A ${type} question`,
    type,
    required: true,
    help: "",
    example: "",
    options: [],
    condition: null,
  };
}

function render(type: FormField["type"], value: string) {
  return renderToStaticMarkup(
    <FieldControl
      field={field(type)}
      value={value}
      onChange={() => undefined}
      disabled={false}
    />,
  );
}

describe("applicant field controls", () => {
  it("uses the native control for each single-value answer type", () => {
    expect(render("email", "a@example.com")).toContain('type="email"');
    expect(render("phone", "+61 2 9876 5432")).toContain('type="tel"');
    expect(render("date", "2027-05-20")).toContain('type="date"');
    const number = render("number", "4.5");
    expect(number).toContain('type="text"');
    expect(number).toContain('inputMode="decimal"');
    expect(render("url", "https://example.com")).toContain('type="url"');
  });

  it("stores a ticked checkbox as a readable Yes answer", () => {
    const ticked = render("checkbox", "Yes");
    expect(ticked).toContain('type="checkbox"');
    expect(ticked).toContain('checked=""');
    expect(ticked).toContain('required=""');
    expect(render("checkbox", "")).not.toContain('checked=""');
  });
});
