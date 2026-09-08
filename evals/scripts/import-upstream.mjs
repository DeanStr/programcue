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
  "CFP-S1-PUBLIC": ["CFP-S1"],
  "CFP-S2": ["CFP-S1"],
  "CFP-S3": ["CFP-S2", "ABS-S1"],
  "CFP-S4": ["CFP-S3", "ABS-S3"],
  "ABS-S1": ["CFP-S2"],
  "ABS-S2": ["CFP-S3"],
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
    instruction:
      "After completing the speaker checks and recording the submitted/edited checkpoints, switch_persona to organizer. In the canonical event's Applications queue, open the CI proposal and verify its title and revised abstract. Publish that observed authenticated organiser detail URL (/admin/submissions/:submissionId) as proposalUrl for CFP-S3. This is an ordinary record route requiring organiser access, not a credential or capability link. Do not use the applicant portal's draft query URL, construct a URL from a record ID, or substitute the queue URL. If the detail page cannot be opened and verified, report the handoff blocked.",
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
const bindings = {
  "CFP-S1-PUBLIC": "CFP-S1",
  "CFP-S2": "CFP-S1",
  "CFP-S3": "CFP-S2",
  "SPK-S1": "CFP-S4",
  "EMB-S1": "AIA-S2",
};
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
  "CFP-S1":
    "At original steps 1-2, create a blank DevFlow Conf 2027 event using Program Cue as its data repository, the fixture dates and public slug devflow-conf-2027. Reuse the configured verified evaluation sender from the showcase event through the explicit Reuse verified sender choice when available; missing sender capability stays an honest provider blocker. Do not clone the showcase or archive its review cycle. If DevFlow Conf 2027 already exists before this run, report blocked and request an operator-owned fresh fixture rather than reusing or clearing unknown work. Verify the new event has no proposals or existing review assignments before continuing; create its CFP with New form if needed. This scenario owns original CFP-S1 steps 1–8 and 12. Anonymous steps 9–11 run separately in CFP-S1-PUBLIC; do not perform them here or treat their unavailable evidence as a publication failure. Verify the published version and publish portalUrl only from observed evidence. After the multi-event probe, restore the organizer's canonical event before finishing. Completion here proves neither anonymous access nor applicant validation.",
  "CFP-S1-PUBLIC":
    "This scenario owns original CFP-S1 steps 9–11. Use the bound published portalUrl in the anonymous persona. Keep security checks enforced: never bypass challenges or substitute authenticated evidence for anonymous evidence. If verification or account requirements prevent interaction, record the precise boundary and report blocked for unavailable checks. Applicant checks run independently in CFP-S2; do not create a submission here.",
  "CFP-S2":
    "Saved fixture access does not prove ordinary signup or email verification. Record those parts as unexercised when using fixture activation; do not claim the full CFP-05 requirement passed merely because a session was pre-captured. Always exercise original step 5's dropdown and conditional-field checks as the authenticated speaker, as well as step 4's validation check: CFP-S1-PUBLIC may be blocked or unselected. These observations establish authenticated behavior only; they do not prove anonymous verification succeeded or that a security challenge is an account requirement.",
  "CFP-S3":
    "Before assigning any reviews, name the initial round CFP Review (create or edit the still-unassigned round). Keep its original numeric scorecard. Sam's saved identity grants no reviewer membership. Perform Jordan's invitation, then switch to reviewer and explicitly accept the pending invitation. Capture both states. Do not publish invitation or magic-link credentials. Leave the completed CFP Review intact; final decisions and CFP closure run only after ABS-S3.",
  "CFP-S4":
    "ABS-S3 has now completed the deeper review checks. In original step 1, select the historical CFP Review results to inspect Sam's original all-4 scorecard and comment; do not overwrite the later Initial Review scores. Return to the current round for decisions. Release decisions and close the CFP only in this scenario.",
  "ABS-S1":
    "This scenario runs after CFP-S2 and before any review assignment in CFP-S3: both original proposals are submitted, editable and undecided, and the CFP is open. Reuse them, add and save the co-author on the CI proposal, verify that participant persisted after reload, and submit the third proposal. Leave all three undecided. Review assignment locks applicant revisions, so complete this setup before switching to review work. Do not release decisions, reset the fixture or archive a review cycle.",
  "ABS-S2":
    "Preserve the completed CFP Review. Do not use Start new review cycle, replace the active plan, reset data or release decisions. For original steps 4-5, use Round progression > Add next round to add Initial Review and then Final Review to the same plan, each with its own new scorecard. Use Edit unassigned round and rubric to configure the exact requested fields, weights, dates and anonymity before assigning work. The original script's Round 1 and Round 2 refer to these named ABS rounds; CFP Review is their earlier prerequisite. Add Sam to Initial Review's pool and leave Final Review's pool distinct. Before original step 7, complete the real progression prerequisite: in the still-active CFP Review, assign the AI Pair Programmer proposal to Sam, switch to reviewer, fill its existing numeric criteria with 4 and the fixture review comment, and explicitly submit it. Keep the earlier CI review unchanged. Switch back to organizer and use Review advancement to shortlist exactly CI and AI into Initial Review, confirming the two affected proposals and Sam. This closes the completed CFP round, activates Initial Review and creates its two fresh assignments together; no cycle is archived. Verify Initial Review shows 2 assigned and 0 completed, with Docs unassigned; exercise track filtering and reminders in that round. Preserve screenshots of the progression and the round-scoped baseline. If progression is unavailable, record the specific blocker instead of clearing prior work.",
  "ABS-S3":
    "In the reviewer queue, open the two Assigned entries and verify the Initial Review rubric before scoring. Completed CFP Review entries remain available as history; record them explicitly rather than claiming they disappeared or counting them as new assignments. Inspect the stored Initial Review scorecards after submission. Select Initial Review in the organizer results and progress views. Preserve completed CFP Review records; do not reopen or replace them. For weighted arithmetic, record the selected round and complete set of included reviews; if the displayed aggregate includes earlier CFP reviews, include them in the arithmetic. Do not release decisions or advance into Final Review here; CFP-S4 follows these checks. Use download for CSV exports and retain actual bytes.",
  "CNT-S3":
    "CNT-12 cannot borrow later area evidence automatically. Exercise an actual public approval gate now; if no qualifying public surface is available, abstain on that requirement. A visible queue or ZIP-ready message is not byte-content verification.",
  "EMB-S3":
    "EMB-16 remains the original no-republish requirement. Programcue uses immutable published session-content snapshots. Record whether a draft title edit propagates without publishing; do not quietly republish to turn this criterion into a pass. Snapshot publication behavior has a separate regression suite.",
};
fs.mkdirSync(path.join(root, "specs/upstream"), { recursive: true });
for (const name of fs.readdirSync(path.join(root, "upstream/specs")).sort()) {
  const original = YAML.parse(fs.readFileSync(path.join(root, "upstream/specs", name), "utf8"));
  const executionScenarios = original.scenarios.flatMap((scenario) => {
    if (scenario.id !== "CFP-S1") return [scenario];
    // Split the pinned numbered steps without rewriting or dropping their text.
    // Fail if an upstream update changes the boundary we reviewed.
    const steps = scenario.steps.split(/(?=^\d+\. )/m);
    if (
      steps.length !== 12 ||
      steps.some((step, index) => !step.startsWith(`${index + 1}. `)) ||
      steps.join("") !== scenario.steps
    )
      throw new Error("CFP-S1 must contain the pinned 12 numbered steps");
    return [
      {
        ...scenario,
        steps: [...steps.slice(0, 8), steps[11]].join(""),
        success_signals: [scenario.success_signals[0], scenario.success_signals[4]],
      },
      {
        ...scenario,
        id: "CFP-S1-PUBLIC",
        name: "Anonymous visitor checks the published CFP",
        persona: "anonymous",
        steps: steps.slice(8, 11).join(""),
        success_signals: scenario.success_signals.slice(1, 4),
      },
    ];
  });
  const scenarios = executionScenarios.map((scenario) => {
    const persona = scenario.persona === "attendee" ? "anonymous" : scenario.persona;
    const origin = bindings[scenario.id];
    const handoff = handoffs[scenario.id];
    const instructions = [
      "PROGRAMCUE EXECUTION ADAPTATION: Use the configured fixture identities and current saved persona. Replace every sign-out/sign-in role transition below with switch_persona. For public checks switch to anonymous. Never authenticate another identity in the current context. Do not repeat signup when already authenticated; explicitly distinguish pre-provisioned access from signup evidence.",
      "Run the chained suite in the new DevFlow Conf 2027 event created by CFP-S1, not the populated Future of Events 2027 showcase. After each switch_persona, explicitly select DevFlow Conf 2027 through the event picker when that role has event access; applicant pages use the observed bound CFP URL. Accept the invitation to this event before opening its reviewer workspace. Never substitute the showcase's form, schedule, reviews or published programme. Fixture emails override literal example addresses below. Record actual dates, track/format names and any substituted fixture values. Follow the original criterion: substitutions cannot hide a missing capability.",
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
    // These criteria need publication plus real public/applicant interaction.
    // Multi-event criteria remain attached to their unchanged step 12 in S1.
    scenarios: ["CFP-01", "CFP-02", "CFP-03"].includes(r.id)
      ? ["CFP-S1", "CFP-S1-PUBLIC", "CFP-S2"]
      : (r.scenarios ?? []),
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
