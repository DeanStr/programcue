import { aek, run } from "./runtime.mjs";

console.log(
  "After the coordinated production reset, capture organizer, speaker and reviewer. Enter the access code only in the browser. Choose Event organiser, Clean applicant + Create evaluator submitter account, and Clean reviewer respectively. Reviewer access must still be invited and accepted in the scenario. Attendee remains anonymous.",
);
for (const persona of ["organizer", "speaker", "reviewer"]) {
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
