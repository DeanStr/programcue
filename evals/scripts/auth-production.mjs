import { aek, run } from "./runtime.mjs";

console.log(
  "After the coordinated production reset, capture organizer, speaker, co_speaker and reviewer. Enter the access code only in the browser. Choose Event organiser, Clean applicant + Create evaluator submitter account, Co-speaker (Marcus), and Clean reviewer respectively. Co-speaker selection grants no membership and claims no invitation; perform the normal claim in the scenario. Reviewer access must still be invited and accepted in the scenario. Attendee remains anonymous.",
);
for (const persona of ["organizer", "speaker", "co_speaker", "reviewer"]) {
  await run(process.execPath, [
    aek,
    "auth",
    "--config",
    "evalkit.production.yaml",
    "--persona",
    persona,
    "--at",
    "/evaluate",
  ]);
}
