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
