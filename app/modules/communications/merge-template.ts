const VARIABLE_PATTERN = /\{\{\s*([a-z][a-zA-Z0-9.]*)\s*\}\}/g;
const BRACKETED_TEXT_PATTERN = /\[([^\]\r\n]{1,120})\]/gu;
const ANGLE_TEXT_PATTERN = /<([^<>\r\n]{1,120})>/gu;
const SINGLE_BRACE_MERGE_PATTERN =
  /(?<!\{)\{\s*([a-z][a-zA-Z0-9.]*)\s*\}(?!\})/gu;
const PLACEHOLDER_INSTRUCTION_PATTERN =
  /^(?:insert|add|enter|provide|replace|fill\s+in|include)\b/iu;
const PLACEHOLDER_LABEL_PATTERN =
  /^(?:(?:recipient|administrator|admin|organizer|organiser|speaker|reviewer|event|contact|your)\s+).*(?:name|e-?mail|contact|deadline|due\s+date|dates?|link|url|phone|address)$/iu;
const EXPLICIT_PLACEHOLDER_LABELS = new Set([
  "company name",
  "email address",
  "first name",
  "system/tool name",
]);

export type MergeValues = Record<string, string | number | null | undefined>;

export type UnresolvedTemplateToken = {
  field: "subject" | "body" | "physicalAddress" | "buttonText" | "buttonUrl";
  token: string;
};

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
    .map((match) => match[1])
    .filter(
      (variable, index, variables) => variables.indexOf(variable) === index,
    );
}

function isHighConfidencePlaceholderLabel(value: string) {
  const label = value.trim();
  return (
    PLACEHOLDER_INSTRUCTION_PATTERN.test(label) ||
    PLACEHOLDER_LABEL_PATTERN.test(label) ||
    EXPLICIT_PLACEHOLDER_LABELS.has(label.toLowerCase()) ||
    label.toLowerCase() === "placeholder"
  );
}

function isKnownMergeVariable(value: string) {
  return (
    value === "submission.url" ||
    Object.hasOwn(representativeMergeValues, value)
  );
}

function findMergeToken(template: string) {
  return template.match(new RegExp(VARIABLE_PATTERN.source))?.[0] ?? null;
}

function findExtraBraceMergeToken(template: string) {
  const extraOpen = template.indexOf("{{{");
  if (extraOpen >= 0) {
    const lineEnd = template.indexOf("\n", extraOpen);
    const matchedClose = template.indexOf("}}", extraOpen + 3);
    let end =
      matchedClose >= 0
        ? matchedClose + 2
        : lineEnd >= 0
          ? lineEnd
          : template.length;
    while (template[end] === "}" && end < extraOpen + 122) end += 1;
    return template.slice(extraOpen, Math.min(end, extraOpen + 122));
  }
  const extraClose = template.indexOf("}}}");
  if (extraClose >= 0) {
    const start = template.lastIndexOf("{{", extraClose);
    let end = extraClose + 3;
    while (template[end] === "}" && end < extraClose + 120) end += 1;
    return template.slice(start >= 0 ? start : extraClose, end);
  }
  return null;
}

function findMalformedMergeToken(template: string) {
  const open = template.indexOf("{{");
  const close = template.indexOf("}}");
  if (open >= 0) {
    const lineEnd = template.indexOf("\n", open);
    const matchedClose = template.indexOf("}}", open + 2);
    const end =
      matchedClose >= 0
        ? matchedClose + 2
        : lineEnd >= 0
          ? lineEnd
          : template.length;
    return template.slice(open, Math.min(end, open + 122));
  }
  if (close >= 0) {
    const prefix = template
      .slice(Math.max(0, close - 120), close)
      .match(/[a-z][a-zA-Z0-9.]*\s*$/u)?.[0];
    return prefix ? `${prefix}}}` : null;
  }
  return null;
}

export function findUnresolvedTemplateToken(template: string) {
  const extraBraceMerge = findExtraBraceMergeToken(template);
  if (extraBraceMerge) return extraBraceMerge;
  const withoutMergeVariables = template.replace(VARIABLE_PATTERN, "");
  const malformedMerge = findMalformedMergeToken(withoutMergeVariables);
  if (malformedMerge) return malformedMerge;

  for (const match of template.matchAll(SINGLE_BRACE_MERGE_PATTERN)) {
    if (isKnownMergeVariable(match[1])) return match[0];
  }

  for (const match of template.matchAll(BRACKETED_TEXT_PATTERN)) {
    const token = match[0];
    const end = (match.index ?? 0) + token.length;
    // Markdown link labels are authored content, even when their label uses a
    // word such as "Contact" or "Deadline".
    if (template[end] === "(") continue;
    if (isHighConfidencePlaceholderLabel(match[1])) return token;
  }
  for (const match of template.matchAll(ANGLE_TEXT_PATTERN)) {
    if (isHighConfidencePlaceholderLabel(match[1])) return match[0];
  }
  return null;
}

export function findUnresolvedTemplateContent(
  input: {
    subject: string;
    body: string;
    physicalAddress?: string;
    buttonText?: string;
    buttonUrl?: string;
  },
  options?: {
    allowedMergeVariables?: readonly string[];
  },
): UnresolvedTemplateToken | null {
  const allowedMergeVariables = options?.allowedMergeVariables
    ? new Set(options.allowedMergeVariables)
    : null;
  const fields = [
    ["subject", input.subject, true],
    ["body", input.body, true],
    ["physicalAddress", input.physicalAddress, false],
    ["buttonText", input.buttonText, false],
    ["buttonUrl", input.buttonUrl, false],
  ] as const;
  for (const [field, value, supportsMerge] of fields) {
    if (value === undefined) continue;
    if (supportsMerge && allowedMergeVariables) {
      for (const match of value.matchAll(
        new RegExp(VARIABLE_PATTERN.source, "g"),
      )) {
        if (!allowedMergeVariables.has(match[1])) {
          return { field, token: match[0] };
        }
      }
    }
    const token =
      (!supportsMerge && findMergeToken(value)) ||
      findUnresolvedTemplateToken(value);
    if (token) return { field, token };
  }
  return null;
}

export function unresolvedTemplateTokenMessage(
  finding: UnresolvedTemplateToken,
) {
  const labels: Record<UnresolvedTemplateToken["field"], string> = {
    subject: "Subject",
    body: "Body",
    physicalAddress: "Physical address",
    buttonText: "Button text",
    buttonUrl: "Button URL",
  };
  return `${labels[finding.field]} contains unresolved template token ${JSON.stringify(finding.token)}. Replace it with a supported merge field or remove the unavailable detail.`;
}

export function renderMergeTemplate(template: string, values: MergeValues) {
  const unknown = new Set<string>();
  const rendered = template.replace(VARIABLE_PATTERN, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) {
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

export function formatTaskDueDate(dueAt: number, timeZone: string) {
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(dueAt * 1_000))} (${timeZone})`;
}

export const representativeMergeValues: MergeValues = {
  "recipient.name": "Alex Morgan",
  "recipient.firstName": "Alex",
  "event.name": "Future of Events",
  "event.dates": "20–22 May 2027",
  "submission.title": "A practical session proposal",
  "decision.outcome": "accepted",
  "decision.rationale":
    "The proposal is a strong fit for the programme and audience.",
  "decision.feedback":
    "The reviewers appreciated the practical examples and suggested clarifying the intended audience.",
  "task.title": "Upload final presentation",
  "task.dueDate": "Sep 20, 2026, 5:00 PM (America/Toronto)",
  "schedule.changes":
    "Moved: Practical AI — Main stage, May 21, 10:00 AM → Studio, May 21, 11:00 AM",
  "schedule.url":
    "https://app.programcue.com/public/programme/future-of-events-2027",
};
