import { describe, expect, it } from "vitest";
import {
  buildDeliverables,
  type DeliverableTask,
  deliverablesFilterSchema,
} from "./deliverables";

const speaker = (id: string) => ({
  id,
  name: `Speaker ${id}`,
  email: `${id}@example.com`,
});
const task = (
  id: string,
  targetId: string,
  status: string,
  extra: Partial<DeliverableTask> = {},
): DeliverableTask => ({
  id,
  templateId: "slides",
  targetType: "speaker",
  targetId,
  title: "Slides",
  status,
  dueAt: 100,
  participantActionable: true,
  ...extra,
});
const workspace = {
  speakers: [speaker("one"), speaker("two"), speaker("three"), speaker("four")],
  templates: [
    { id: "slides", name: "Slides", targetType: "speaker", status: "active" },
    { id: "bio", name: "Biography", targetType: "speaker", status: "active" },
  ],
  tasks: [
    task("1", "one", "in_progress"),
    task("2", "one", "completed"),
    task("3", "two", "submitted"),
    task("4", "three", "waived"),
    task("5", "four", "in_progress", { participantActionable: false }),
    task("6", "inactive", "in_progress"),
    task("7", "one", "in_progress", {
      targetType: "session",
      templateId: null,
    }),
  ],
};
const matrix = (filters: Record<string, unknown> = {}) =>
  buildDeliverables(workspace, deliverablesFilterSchema.parse(filters), 200);
describe("speaker deliverables matrix", () => {
  it("preserves historical assignments and all cell statuses when filtering outstanding work", () => {
    const result = matrix({ state: "outstanding" });
    expect(result.rows.map((s) => s.id)).toEqual(["one", "two", "four"]);
    expect(result.rows[0].cells[0].tasks.map((t) => t.status)).toEqual([
      "in_progress",
      "completed",
    ]);
    expect(result.allColumns.map((c) => c.id)).toEqual(["slides", "bio"]);
  });
  it("reminds only actionable outstanding speakers, excluding review-only evidence, completed work and inactive roster entries", () => {
    expect(matrix().recipients.map((s) => s.id)).toEqual(["one"]);
    expect(matrix({ state: "submitted" }).recipients).toEqual([]);
    expect(matrix({ state: "overdue" }).rows.map((s) => s.id)).toEqual([
      "one",
      "four",
    ]);
    expect(matrix({ state: "complete" }).recipients).toEqual([]);
    expect(matrix({ template: "bio" }).recipients).toEqual([]);
    expect(matrix({ q: "two@example.com" }).rows.map((s) => s.id)).toEqual([
      "two",
    ]);
  });
  it("distinguishes unassigned requirements from completed work", () => {
    expect(matrix({ template: "bio", state: "unassigned" }).rows).toHaveLength(
      4,
    );
    expect(matrix({ template: "slides", state: "unassigned" }).rows).toEqual(
      [],
    );
    expect(matrix({ state: "complete" }).rows.map((s) => s.id)).toEqual([
      "one",
      "three",
    ]);
  });
  it("selects recipients across all pages and deduplicates multiple outstanding tasks per speaker", () => {
    const speakers = Array.from({ length: 60 }, (_, i) => speaker(String(i)));
    const tasks = speakers.flatMap((s) => [
      task(`${s.id}-a`, s.id, "in_progress"),
      task(`${s.id}-b`, s.id, "in_progress"),
    ]);
    const result = buildDeliverables(
      { ...workspace, speakers, tasks },
      deliverablesFilterSchema.parse({ page: 2 }),
      200,
    );
    expect(result.recipients).toHaveLength(60);
  });
  it("rejects invalid filter states and page numbers", () => {
    for (const value of [
      { state: "arbitrary" },
      { page: 0 },
      { columns: -1 },
      { page: 1.5 },
    ])
      expect(deliverablesFilterSchema.safeParse(value).success).toBe(false);
  });
});
