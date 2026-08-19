import { useState } from "react";

import type { RecommendationChoice } from "~/modules/evaluations/evaluation-recommendation-choices";

export function RecommendationChoiceFields({
  choices,
}: {
  choices: readonly RecommendationChoice[];
}) {
  const [rows, setRows] = useState(() =>
    choices.map((choice) => ({ ...choice })),
  );

  function move(index: number, offset: -1 | 1) {
    setRows((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  return (
    <fieldset className="stack pc-plain-fieldset">
      <legend className="label">Overall recommendation choices</legend>
      <p className="help">
        Configure 2–7 choices in the order reviewers and result breakdowns
        should show them. Choice identifiers remain stable when labels or order
        change. Choices become immutable as soon as this round has assignments.
        Final applicant decisions remain separate and are never inferred from a
        reviewer choice.
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Reviewer-facing label</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((choice, index) => (
              <tr key={choice.id}>
                <td className="pc-num">{index + 1}</td>
                <td>
                  <input
                    type="hidden"
                    name="recommendationChoiceId"
                    value={choice.id}
                  />
                  <input
                    className="input"
                    name="recommendationChoiceLabel"
                    aria-label={`Recommendation choice ${index + 1}`}
                    value={choice.label}
                    maxLength={120}
                    required
                    onChange={(event) => {
                      const label = event.target.value;
                      setRows((current) =>
                        current.map((row, rowIndex) =>
                          rowIndex === index ? { ...row, label } : row,
                        ),
                      );
                    }}
                  />
                </td>
                <td>
                  <div className="inline-form">
                    <button
                      className="btn small"
                      type="button"
                      disabled={index === 0}
                      aria-label={`Move ${choice.label || `choice ${index + 1}`} up`}
                      onClick={() => move(index, -1)}
                    >
                      Move up
                    </button>
                    <button
                      className="btn small"
                      type="button"
                      disabled={index === rows.length - 1}
                      aria-label={`Move ${choice.label || `choice ${index + 1}`} down`}
                      onClick={() => move(index, 1)}
                    >
                      Move down
                    </button>
                    <button
                      className="btn small danger"
                      type="button"
                      disabled={rows.length <= 2}
                      aria-label={`Remove ${choice.label || `choice ${index + 1}`}`}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((_, rowIndex) => rowIndex !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn small"
        type="button"
        disabled={rows.length >= 7}
        onClick={() =>
          setRows((current) => [
            ...current,
            { id: crypto.randomUUID(), label: "" },
          ])
        }
      >
        Add recommendation choice
      </button>
    </fieldset>
  );
}
