import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  READINESS_ACCEPTANCE_PROMPT,
  seedReadinessAcceptanceEvent,
} from "~/platform/demo/assistant-readiness-fixture.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import { listAssistantRunReports } from "./ai-run-report.server";
import type { WorkersAiBinding } from "./workers-ai-provider.server";

const runtime = env as unknown as CloudflareEnvironment;
const settings = env as unknown as {
  ASSISTANT_ACCEPTANCE_PROVIDER: string;
  ASSISTANT_ACCEPTANCE_MODEL: string;
};
const organiser: Viewer = {
  personId: "person-demo-admin",
  name: "Acceptance organiser",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

for (const scenario of [
  "success",
  "insufficient_information",
  "no_blockers",
  "stale_before_approval",
  "provider_failure",
] as const) {
  test(`real configured model: ${scenario}`, async () => {
    await ensureDemoData(runtime);
    await env.DB.prepare(
      "UPDATE organisation_ai_settings SET provider = ?, model = ? WHERE organisation_id = ?",
    )
      .bind(
        settings.ASSISTANT_ACCEPTANCE_PROVIDER,
        settings.ASSISTANT_ACCEPTANCE_MODEL,
        organiser.organisationId,
      )
      .run();
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      scenario,
    );
    if (scenario === "success")
      await env.DB.prepare(
        `INSERT INTO memberships (id, organisation_id, event_id, person_id, role, accepted_at, created_at) VALUES (?, ?, ?, 'person-demo-owner', 'owner', unixepoch(), unixepoch())`,
      )
        .bind(crypto.randomUUID(), organiser.organisationId, fixture.eventId)
        .run();
    let modelCallAttempts = 0;
    let realProviderCalls = 0;
    let failureInjected = false;
    const shouldInjectFailure = () => {
      modelCallAttempts += 1;
      if (scenario === "provider_failure" && modelCallAttempts === 2) {
        failureInjected = true;
        return true;
      }
      realProviderCalls += 1;
      return false;
    };
    const binding = runtime.AI as unknown as WorkersAiBinding | undefined;
    if (settings.ASSISTANT_ACCEPTANCE_PROVIDER === "workers_ai" && !binding)
      throw new Error(
        "Live Workers AI acceptance requires the remote AI binding.",
      );
    const acceptanceRuntime =
      settings.ASSISTANT_ACCEPTANCE_PROVIDER === "workers_ai" && binding
        ? {
            ...runtime,
            AI: {
              get aiGatewayLogId() {
                return failureInjected ? null : binding.aiGatewayLogId;
              },
              async run(model: string, input: Record<string, unknown>) {
                if (shouldInjectFailure())
                  throw new Error(
                    "Explicit injected provider failure after a real model call",
                  );
                return binding.run(model, input);
              },
            } as unknown as Ai,
          }
        : runtime;
    const service = new AiAssistantService(acceptanceRuntime, {
      fetcher: async (request, init) => {
        if (shouldInjectFailure())
          return Response.json(
            {
              error: {
                message:
                  "Explicit injected provider failure after a real model call",
              },
            },
            { status: 503 },
          );
        return fetch(request, init);
      },
    });
    let action: unknown = null;
    let error: string | null = null;
    try {
      if (scenario === "provider_failure") {
        await expect(
          service.ask(fixture.viewer, READINESS_ACCEPTANCE_PROMPT),
        ).rejects.toThrow(
          settings.ASSISTANT_ACCEPTANCE_PROVIDER === "workers_ai"
            ? /Workers AI request failed/
            : /injected provider failure/,
        );
        expect(failureInjected).toBe(true);
        expect(modelCallAttempts).toBe(2);
        expect(realProviderCalls).toBe(1);
      } else {
        const result = await service.ask(
          fixture.viewer,
          READINESS_ACCEPTANCE_PROMPT,
        );
        expect(realProviderCalls).toBeGreaterThan(0);
        expect(result.evidence.length).toBeGreaterThan(0);
        if (
          scenario === "no_blockers" ||
          scenario === "insufficient_information"
        )
          expect(result.proposals).toEqual([]);
        else {
          expect(result.proposals).toHaveLength(1);
          expect(
            result.evidence.some((item) => item.id === fixture.conflictId),
          ).toBe(true);
          expect(result.proposals[0].toolName).toBe("propose_task");
          expect(result.proposals[0].title).toMatch(
            /room|venue|conflict|schedule/i,
          );
          expect(
            await env.DB.prepare(
              "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
            )
              .bind(fixture.eventId)
              .first(),
          ).toMatchObject({ count: 0 });
          if (scenario === "stale_before_approval") {
            await env.DB.prepare(
              "UPDATE schedule_conflicts SET resolved_at = unixepoch() WHERE id = ? AND event_id = ?",
            )
              .bind(fixture.conflictId, fixture.eventId)
              .run();
            await expect(
              service.approveProposal(
                fixture.viewer,
                result.proposals[0].id,
                true,
              ),
            ).rejects.toThrow(/changed after inspection/);
          } else {
            const proposed = result.proposals[0];
            expect(
              proposed.toolName === "propose_task" &&
                proposed.task?.ownerPersonId,
            ).toBe(organiser.personId);
            const edited = await service.reviewTaskProposal(
              fixture.viewer,
              proposed.id,
              {
                decision: "edit",
                title: proposed.title,
                description: `${proposed.toolName === "propose_task" ? (proposed.task?.description ?? "") : ""}\nConfirm the venue handoff.`,
                ownerPersonId: organiser.personId,
              },
            );
            action = await service.approveProposal(
              fixture.viewer,
              edited.replacementProposalId,
              true,
            );
            expect(
              (
                await new AiAssistantService(runtime).listRecentProposals(
                  fixture.viewer,
                )
              )[0].executedTaskId,
            ).toBeTruthy();
          }
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      const report = {
        scenario,
        mode: "real model with isolated local D1",
        outcome: error ? "failed" : "passed",
        injectedFailure: failureInjected,
        modelCallAttempts,
        realProviderCalls,
        error,
        action,
        reports: await listAssistantRunReports(runtime, fixture.viewer),
      };
      console.info(`ASSISTANT_ACCEPTANCE_REPORT ${JSON.stringify(report)}`);
    }
  });
}
