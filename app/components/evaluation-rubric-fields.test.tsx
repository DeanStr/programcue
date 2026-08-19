import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RubricFields } from "./evaluation-rubric-fields";

function render(names: string[]) {
  return renderToStaticMarkup(
    <RubricFields
      criteria={names.map((name) => ({
        name,
        description: "Reviewer guidance",
        inputType: "dropdown",
        options: ["First", "Second"],
        weightPercent: 0,
        required: true,
      }))}
    />,
  );
}

describe("evaluation rubric fields", () => {
  it("explains built-in review fields and uses a neutral dropdown example", () => {
    const markup = render(["Audience level"]);

    expect(markup).toContain(
      "Every review already includes a required overall recommendation and confidence rating",
    );
    expect(markup).toContain(
      'placeholder="Introductory, Intermediate, Advanced"',
    );
    expect(markup).not.toContain("Built-in review field");
    expect(markup).not.toContain("aria-describedby");
  });

  it("warns when existing criteria duplicate built-in review fields", () => {
    const markup = render([" Recommendation ", "CONFIDENCE"]);

    expect(markup).toContain(
      "Every review already requires an overall recommendation",
    );
    expect(markup).toContain(
      "Every review already requires a confidence rating",
    );
    expect(markup.match(/Built-in review field/gu)).toHaveLength(2);
    expect(markup.match(/role="status"/gu)).toHaveLength(2);
    expect(markup.match(/aria-describedby=/gu)).toHaveLength(2);
  });
});
