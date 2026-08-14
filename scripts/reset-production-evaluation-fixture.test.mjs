import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseArguments,
  resetProductionEvaluationFixture,
} from "./reset-production-evaluation-fixture.mjs";

describe("production evaluation fixture reset command", () => {
  it("requires explicit confirmation and rejects target overrides", () => {
    assert.throws(() => parseArguments([]), /explicit --yes/u);
    assert.throws(
      () => parseArguments(["--yes", "--url", "https://app.example/path"]),
      /Unknown argument/u,
    );
    assert.deepEqual(parseArguments(["--yes"]), {
      help: false,
    });
  });

  it("posts only the fixed reset request and verifies the response", async () => {
    let captured;
    const result = await resetProductionEvaluationFixture({
      origin: "https://app.programcue.com",
      secret: "s".repeat(32),
      fetcher: async (request, init) => {
        captured = { request: request.toString(), init };
        return Response.json({
          evidence: {
            fixturePeople: 4,
            fixtureVerifiedPeople: 0,
            fixtureSessions: 0,
            fixtureAccounts: 0,
            fixtureCalendarConnections: 0,
            fixtureVerificationTokens: 0,
            verifiedSenders: 1,
            workersAiSettings: 1,
            fixtureOrganisationAdministrators: 1,
            fixtureOrganisationMemberships: 2,
            fixtureApplicantMemberships: 0,
            nonDiscardedExtraEvents: 0,
          },
        });
      },
    });

    assert.equal(
      captured.request,
      "https://app.programcue.com/api/internal/evaluation-fixture/reset",
    );
    assert.equal(captured.init.method, "POST");
    assert.equal(
      captured.init.headers.authorization,
      `Bearer ${"s".repeat(32)}`,
    );
    assert.deepEqual(JSON.parse(captured.init.body), {
      confirmation: "Future of Events 2025",
    });
    assert.equal(result.evidence.fixturePeople, 4);
  });

  it("fails instead of accepting a partial reset result", async () => {
    await assert.rejects(
      resetProductionEvaluationFixture({
        origin: "https://app.programcue.com",
        secret: "s".repeat(32),
        fetcher: async () => Response.json({ evidence: { fixturePeople: 3 } }),
      }),
      /complete fixture/u,
    );
  });

  it("never sends the reset bearer secret to another origin", async () => {
    await assert.rejects(
      resetProductionEvaluationFixture({
        origin: "https://evaluation-proxy.example",
        secret: "s".repeat(32),
        fetcher: async () => {
          throw new Error("The request must not be sent.");
        },
      }),
      /targets only https:\/\/app\.programcue\.com/u,
    );
  });
});
