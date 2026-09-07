import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(fs.readFileSync(path.join(root, "upstream/source.json"), "utf8"));
for (const [name, hash] of Object.entries(provenance.sha256)) {
  const bytes = fs.readFileSync(path.join(root, "upstream", name));
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw new Error(`Changed upstream snapshot: ${name}`);
}
const dependencies = {
  "CFP-S2": ["CFP-S1"],
  "CFP-S3": ["CFP-S2"],
  "CFP-S4": ["CFP-S3"],
  "ABS-S1": ["CFP-S4"],
  "ABS-S2": ["ABS-S1"],
  "ABS-S3": ["ABS-S2"],
  "SPK-S1": ["CFP-S4"],
  "SPK-S2": ["SPK-S1"],
  "SPK-S3": ["SPK-S2"],
  "CNT-S1": ["SPK-S3"],
  "CNT-S2": ["CNT-S1"],
  "CNT-S3": ["CNT-S2"],
  "AIA-S1": ["CNT-S3"],
  "AIA-S2": ["AIA-S1"],
  "EMB-S1": ["AIA-S2"],
  "EMB-S2": ["EMB-S1"],
  "EMB-S3": ["EMB-S2"],
  "CRM-S1": ["SPK-S3"],
  "CRM-S2": ["CRM-S1"],
};
const handoffs = {
  "CFP-S1": {
    name: "portalUrl",
    instruction: "Publish the observed public CFP portal URL as portalUrl.",
  },
  "CFP-S2": {
    name: "proposalUrl",
    instruction: "Publish the saved CI proposal's ordinary detail URL as proposalUrl.",
  },
  "CFP-S4": {
    name: "sessionUrl",
    instruction: "Publish the accepted CI session's ordinary admin detail URL as sessionUrl.",
  },
  "AIA-S2": {
    name: "programmeUrl",
    instruction: "Publish the observed public programme URL as programmeUrl.",
  },
};
const bindings = { "CFP-S2": "CFP-S1", "CFP-S3": "CFP-S2", "SPK-S1": "CFP-S4", "EMB-S1": "AIA-S2" };
const checkpoints = {
  "CFP-S2": {
    submitted: "The submission confirmation and saved dashboard row were inspected.",
    edited: "The edited abstract was inspected after reload.",
  },
  "CFP-S4": {
    decisions: "Both persisted organizer decision statuses were inspected.",
    handoff: "The accepted session and transferred metadata were inspected.",
    closed: "The public closed state and speaker edit lock were exercised.",
  },
  "ABS-S3": {
    aggregates: "The results table, recorded scores and both sort orders were inspected.",
  },
  "CNT-S3": { versions: "The attributed version history and restored abstract were inspected." },
};
const selectors = {
  "CFP-05": ["CFP-S2", "submitted"],
  "CFP-12": ["CFP-S4", "decisions"],
  "CFP-15": ["CFP-S4", "handoff"],
  "CFP-04": ["CFP-S4", "closed"],
  "CFP-16": ["CFP-S4", "closed"],
  "ABS-10": ["ABS-S3", "aggregates"],
  "CNT-11": ["CNT-S3", "versions"],
};
const notices = {
  "CFP-S2":
    "Saved fixture access does not prove ordinary signup or email verification. Record those parts as unexercised when using fixture activation; do not claim the full CFP-05 requirement passed merely because a session was pre-captured.",
  "CFP-S3":
    "Sam's saved identity grants no reviewer membership. Perform Jordan's invitation, then switch to reviewer and explicitly accept the pending invitation. Capture both states. Do not publish invitation or magic-link credentials.",
  "ABS-S3":
    "For weighted arithmetic, record the complete set of included reviews; do not ignore earlier CFP reviews. Use download for CSV exports and retain actual bytes.",
  "CNT-S3":
    "CNT-12 cannot borrow later area evidence automatically. Exercise an actual public approval gate now; if no qualifying public surface is available, abstain on that requirement. A visible queue or ZIP-ready message is not byte-content verification.",
  "EMB-S3":
    "EMB-16 remains the original no-republish requirement. Programcue uses immutable published session-content snapshots. Record whether a draft title edit propagates without publishing; do not quietly republish to turn this criterion into a pass. Snapshot publication behavior has a separate regression suite.",
};
fs.mkdirSync(path.join(root, "specs/upstream"), { recursive: true });
for (const name of fs.readdirSync(path.join(root, "upstream/specs")).sort()) {
  const original = YAML.parse(fs.readFileSync(path.join(root, "upstream/specs", name), "utf8"));
  const scenarios = original.scenarios.map((scenario) => {
    const persona = scenario.persona === "attendee" ? "anonymous" : scenario.persona;
    const origin = bindings[scenario.id];
    const handoff = handoffs[scenario.id];
    const instructions = [
      "PROGRAMCUE EXECUTION ADAPTATION: Use the configured fixture identities and current saved persona. Replace every sign-out/sign-in role transition below with switch_persona. For public checks switch to anonymous. Never authenticate another identity in the current context. Do not repeat signup when already authenticated; explicitly distinguish pre-provisioned access from signup evidence.",
      "Use the canonical Future of Events 2027 event when a pre-seeded event is needed. Fixture emails override literal example addresses below. Record actual dates, track/format names and any substituted fixture values. Follow the original criterion: substitutions cannot hide a missing capability.",
      notices[scenario.id] ?? "",
      origin
        ? `Use the bound ${handoffs[origin].name} from ${origin}; verify the record before continuing.`
        : "",
      `ORIGINAL SCENARIO SCRIPT:\n${scenario.steps}`,
      checkpoints[scenario.id]
        ? "Record each declared checkpoint immediately after the corresponding check was actually exercised, citing successful evidence steps. A checkpoint records reach, never success; leave unexercised checks unpublished."
        : "",
      handoff
        ? `${handoff.instruction} Call publish_output with successful evidence step references. Use only ordinary non-secret HTTP(S) URLs. If it cannot be observed, report blocked; never invent a URL.`
        : "",
      "Missing optional features are findings: record them and continue the reachable script. Use feature_not_found for an absent core capability and blocked for unavailable access/evidence. Do not turn provider or evidence-tool failures into product verdicts.",
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      id: scenario.id,
      name: scenario.name,
      kind: "browser",
      persona,
      requiresAuth: persona !== "anonymous",
      allowedPersonas: ["organizer", "speaker", "reviewer", "anonymous"],
      instructions,
      successSignals: scenario.success_signals ?? [],
      dependsOn: dependencies[scenario.id] ?? [],
      ...(handoff ? { outputs: { [handoff.name]: { type: "url" } } } : {}),
      ...(origin
        ? { inputs: { [handoffs[origin].name]: { from: origin, output: handoffs[origin].name } } }
        : {}),
      ...(checkpoints[scenario.id] ? { checkpoints: checkpoints[scenario.id] } : {}),
    };
  });
  const rubric = original.rubric.map((r) => ({
    id: r.id,
    criterion: r.criterion,
    weight: r.weight,
    tags: [r.type],
    scenarios: r.scenarios ?? [],
    grader:
      r.testability === "auto"
        ? { type: "llm" }
        : r.testability === "manual"
          ? { type: "manual" }
          : { type: "hybrid", autoShare: 0.5 },
    passCriteria: r.pass_criteria,
    ...(r.evidence ? { evidence: r.evidence } : {}),
    ...(r.manual_instructions ? { manualInstructions: r.manual_instructions } : {}),
    ...(selectors[r.id] ? { checkpoints: { [selectors[r.id][0]]: [selectors[r.id][1]] } } : {}),
  }));
  fs.writeFileSync(
    path.join(root, "specs/upstream", name),
    YAML.stringify({
      id: original.area,
      title: original.title,
      weight: original.area_weight,
      optional: original.optional ?? false,
      description: original.overview,
      scenarios,
      rubric,
    }),
  );
}
console.log(
  "Imported the pinned 7-area upstream suite; AEK hybrid weights use an explicit 50/50 policy.",
);
