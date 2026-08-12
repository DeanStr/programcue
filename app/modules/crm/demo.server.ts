import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  DEMO_IDENTITY,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";

export async function ensureDemoCrmData(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;
  await ensureDemoSpeakerData(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES (
       'membership-demo-admin-org', ?, NULL, ?, 'administrator',
       unixepoch(), unixepoch(), unixepoch()
     )`,
  )
    .bind(DEMO_ORGANISATION_ID, DEMO_IDENTITY.personId)
    .run();
}
