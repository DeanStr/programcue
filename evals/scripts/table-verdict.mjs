// Admission rules for the improvement loop, independent of HTML rendering.
export function retainedTableVerdict(
  current,
  baseline,
  history,
  { unchangedPaint = null, viewportPassed = false } = {},
) {
  const matches = (stage, labels) =>
    labels.every((label) => stage.input.inputs[label].sha256 === current.inputs[label].sha256);
  const improvement = history
    .filter((stage) => stage.mode === "improvement" && matches(stage, ["candidate"]) && stage.data)
    .at(-1);
  const external = history
    .filter((stage) => stage.mode === "external" && matches(stage, ["candidate"]) && stage.data)
    .at(-1);
  const quality = history
    .filter(
      (stage) => matches(stage, ["candidate", "fullview", "mobile"]) && stage.quality.pass === 5,
    )
    .at(-1);
  const unchanged =
    current.inputs.candidate.sha256 === baseline.inputs.candidate.sha256 || Boolean(unchangedPaint);
  const componentAccepted =
    !unchanged && improvement?.data.decision.counts.win === 5 && Boolean(quality);
  return {
    unchanged,
    componentAccepted,
    accepted: componentAccepted && viewportPassed,
    improvement: improvement?.name,
    external: external?.name,
    qualitySource: quality?.name,
  };
}
