import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventFieldInputs } from "./event-field-inputs";

describe("event field inputs", () => {
  it("allows finite decimal values accepted by the number-field service", () => {
    const markup = renderToStaticMarkup(
      <EventFieldInputs
        fields={[
          {
            id: "decimal-field",
            label: "Travel distance",
            fieldType: "number",
            options: [],
            participantAccess: "editable",
            required: false,
            valueRevision: 0,
            value: 1.5,
          },
        ]}
      />,
    );

    expect(markup).toContain('type="number"');
    expect(markup).toContain('step="any"');
    expect(markup).toContain('value="1.5"');
  });
});
