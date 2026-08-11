export type SubmissionReferenceRow = {
  publicReference: string;
  title: string;
};

function singleLine(value: string) {
  const normalized = value
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return /^[=+\-@]/u.test(normalized) ? `'${normalized}` : normalized;
}

export function submissionReferenceClipboard(
  rows: readonly SubmissionReferenceRow[],
) {
  if (rows.length === 0) {
    throw new Error(
      "Select at least one application before copying references.",
    );
  }

  return [
    "Reference\tApplication",
    ...rows.map(
      (row) => `${singleLine(row.publicReference)}\t${singleLine(row.title)}`,
    ),
  ].join("\n");
}

export function undoRemainingMilliseconds(
  expiresAtSeconds: number,
  nowMilliseconds: number,
) {
  return Math.max(0, expiresAtSeconds * 1_000 - nowMilliseconds);
}

export function undoRemainingLabel(remainingMilliseconds: number) {
  const seconds = Math.ceil(Math.max(0, remainingMilliseconds) / 1_000);
  if (seconds === 0) return "Undo window expired";
  if (seconds < 60) return `${seconds}s left`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s left`;
}
