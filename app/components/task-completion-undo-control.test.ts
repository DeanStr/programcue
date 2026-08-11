import { describe, expect, it, vi } from "vitest";

import { dismissOwnedTaskCompletionToasts } from "./task-completion-undo-control";

describe("task completion toast ownership", () => {
  it("dismisses every toast created across changing undo notices", () => {
    const dismiss = vi.fn();

    dismissOwnedTaskCompletionToasts(
      new Set(["task-completion:task-1:100", "task-completion:task-2:200"]),
      dismiss,
    );

    expect(dismiss.mock.calls).toEqual([
      ["task-completion:task-1:100"],
      ["task-completion:task-2:200"],
    ]);
  });
});
