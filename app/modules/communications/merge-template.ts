const VARIABLE_PATTERN = /\{\{\s*([a-z][a-zA-Z0-9.]*)\s*\}\}/g;

export type MergeValues = Record<string, string | number | null | undefined>;

export class UnknownMergeVariableError extends Error {
  constructor(readonly variables: string[]) {
    super(
      `Unknown merge ${variables.length === 1 ? "variable" : "variables"}: ${variables.join(", ")}`,
    );
    this.name = "UnknownMergeVariableError";
  }
}

export function mergeTemplateVariables(template: string) {
  return [...template.matchAll(new RegExp(VARIABLE_PATTERN.source, "g"))]
    .map((match) => match[1]!)
    .filter(
      (variable, index, variables) => variables.indexOf(variable) === index,
    );
}

export function renderMergeTemplate(template: string, values: MergeValues) {
  const unknown = new Set<string>();
  const rendered = template.replace(VARIABLE_PATTERN, (_match, key: string) => {
    if (!(key in values)) {
      unknown.add(key);
      return "";
    }
    return String(values[key] ?? "");
  });
  if (unknown.size) throw new UnknownMergeVariableError([...unknown].sort());
  return rendered;
}

export function formatEventDateMarkers(startsAt: number, endsAt: number) {
  const format = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const start = format.format(new Date(startsAt * 1_000));
  const end = format.format(new Date(endsAt * 1_000));
  return start === end ? start : `${start} – ${end}`;
}

export const representativeMergeValues: MergeValues = {
  "recipient.name": "Alex Morgan",
  "recipient.firstName": "Alex",
  "event.name": "Future of Events",
  "event.dates": "20–22 May 2025",
  "submission.title": "A practical session proposal",
  "decision.outcome": "accepted",
  "decision.rationale":
    "The proposal is a strong fit for the programme and audience.",
  "decision.feedback":
    "The reviewers appreciated the practical examples and suggested clarifying the intended audience.",
  "task.title": "Upload final presentation",
};
