import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beginMailboxWatch, createMailpitMailbox } from "agent-eval-kit/email";
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const mailbox = JSON.parse(fs.readFileSync(context.sources.mailbox.path, "utf8"));
const watch = await beginMailboxWatch(createMailpitMailbox(mailbox));
fs.writeFileSync(path.join(context.outputDir, "watch.json"), JSON.stringify(watch));
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: "Established local Mailpit observation before the browser send",
    observations: [
      "Local capture proves delivery to Mailpit, not delivery to an external recipient.",
    ],
    files: [
      { label: "watch", path: "watch.json", filename: "watch.json", mediaType: "application/json" },
    ],
    outputs: {
      watch: { value: "watch", evidenceRefs: ["step:1"] },
      recipient: { value: mailbox.address, evidenceRefs: ["step:1"] },
      subject: { value: `AEK Programcue ${randomUUID()}`, evidenceRefs: ["step:1"] },
    },
  }),
);
