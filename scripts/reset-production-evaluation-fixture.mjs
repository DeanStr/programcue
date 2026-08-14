#!/usr/bin/env node

const RESET_CONFIRMATION = "Future of Events 2027";
const RESET_PATH = "/api/internal/evaluation-fixture/reset";
const RESPONSE_LIMIT = 64 * 1024;
const PRODUCTION_ORIGIN = "https://app.programcue.com";

function usage() {
  return `Usage: npm run evaluation:fixture:reset -- --yes

Requires EVALUATION_FIXTURE_SECRET in the invoking shell. The matching secret,
temporary EVALUATION_RESEND_API_KEY and all four EVALUATOR_*_EMAIL values must
already be installed on the ordinary production Worker.`;
}

export function parseArguments(arguments_) {
  let confirmed = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--yes") {
      confirmed = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!confirmed) {
    throw new Error(
      `Refusing to reset ${RESET_CONFIRMATION} without the explicit --yes flag.`,
    );
  }

  return { help: false };
}

async function boundedText(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RESPONSE_LIMIT) {
    throw new Error("The reset endpoint returned an oversized response.");
  }
  return new TextDecoder().decode(bytes);
}

export async function resetProductionEvaluationFixture({
  origin,
  secret,
  fetcher = fetch,
}) {
  if (origin !== PRODUCTION_ORIGIN) {
    throw new Error(
      `The production evaluation reset targets only ${PRODUCTION_ORIGIN}.`,
    );
  }
  const configuredSecret = secret?.trim() ?? "";
  if (configuredSecret.length < 32) {
    throw new Error(
      "EVALUATION_FIXTURE_SECRET must contain at least 32 characters.",
    );
  }
  const response = await fetcher(new URL(RESET_PATH, origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${configuredSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: RESET_CONFIRMATION }),
    redirect: "error",
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const responseText = await boundedText(response);
  if (!response.ok) {
    throw new Error(
      `Evaluation fixture reset failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
    );
  }
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("The reset endpoint returned invalid JSON.");
  }
  if (
    !result ||
    typeof result !== "object" ||
    !result.evidence ||
    result.evidence.fixturePeople !== 4 ||
    result.evidence.fixtureVerifiedPeople !== 0 ||
    result.evidence.fixtureSessions !== 0 ||
    result.evidence.fixtureAccounts !== 0 ||
    result.evidence.fixtureCalendarConnections !== 0 ||
    result.evidence.fixtureVerificationTokens !== 0 ||
    result.evidence.verifiedSenders !== 1 ||
    result.evidence.workersAiSettings !== 1 ||
    result.evidence.fixtureOrganisationAdministrators !== 1 ||
    result.evidence.fixtureOrganisationMemberships !== 2 ||
    result.evidence.fixtureApplicantMemberships !== 0 ||
    result.evidence.nonDiscardedExtraEvents !== 0
  ) {
    throw new Error("The reset endpoint did not report a complete fixture.");
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await resetProductionEvaluationFixture({
    origin: PRODUCTION_ORIGIN,
    secret: process.env.EVALUATION_FIXTURE_SECRET,
  });
  console.log(
    `Reset ${RESET_CONFIRMATION}: ${result.evidence.fixturePeople} clean scenario identities, ${result.evidence.verifiedSenders} verified sender, Workers AI configuration seeded.`,
  );
  console.log(
    "Open /evaluate with the shared access code and save only the organizer, clean applicant and clean invited reviewer starting states; activate the clean applicant explicitly. Marcus remains in-scenario co-speaker input. No evaluator mailbox is required for persona access.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
