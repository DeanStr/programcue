import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { IntegrationService } from "~/modules/integrations/integration-service.server";
import {
  AcceleventsReconciliationReportNotFoundError,
  AcceleventsReconciliationReportService,
} from "~/modules/integrations/accelevents-reconciliation-report.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader } from "./accelevents-reconciliation-report";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(role: "administrator" | "speaker", runId: string) {
  return new Request(
    `http://localhost/admin/integrations/accelevents/runs/${encodeURIComponent(runId)}/reconciliation.csv`,
    {
      headers: { cookie: `program_cue_demo_identity=${role}` },
    },
  );
}

async function terminalDryRun() {
  const service = new IntegrationService(workerEnv, {
    createAccelevents: () => ({ validateConnection: async () => undefined }),
  });
  const configured = await service.configureAccelevents(
    {
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      demo: true,
    },
    {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    },
  );
  return service.startRun(
    {
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      demo: true,
    },
    {
      connectionId: configured.connectionId,
      dryRun: true,
      idempotencyKey: `report-${crypto.randomUUID()}`,
    },
  );
}

beforeEach(async () => {
  await new PublicProgrammeService(workerEnv).getPublished(
    "future-of-events-2027",
  );
  await workerEnv.DB.batch([
    workerEnv.DB.prepare("DELETE FROM integration_entity_mappings"),
    workerEnv.DB.prepare("DELETE FROM integration_runs"),
    workerEnv.DB.prepare("DELETE FROM integration_connections"),
    workerEnv.DB.prepare(
      "DELETE FROM operation_jobs WHERE type = 'integration.accelevents.export'",
    ),
  ]);
});

describe("Accelevents reconciliation report route", () => {
  it("downloads an injection-safe immutable CSV from stored terminal run data", async () => {
    const run = await terminalDryRun();
    const firstItem = await workerEnv.DB.prepare(
      `SELECT item.id, item.entity_type AS entityType,
              item.entity_id AS entityId, item.diff_json AS diffJson,
              run.connection_id AS connectionId
         FROM integration_run_items item
         JOIN integration_runs run ON run.id = item.run_id
        WHERE item.run_id = ? ORDER BY item.id LIMIT 1`,
    )
      .bind(run.runId)
      .first<{
        id: string;
        entityType: string;
        entityId: string;
        diffJson: string;
        connectionId: string;
      }>();
    const diff = JSON.parse(firstItem!.diffJson) as Record<string, unknown>;
    await workerEnv.DB.prepare(
      `UPDATE integration_run_items
          SET diff_json = json_set(diff_json, '$.label', '=unsafe-label')
        WHERE id = ?`,
    )
      .bind(firstItem!.id)
      .run();

    const response = await loader({
      request: request("administrator", run.runId),
      params: { runId: run.runId },
      context: context(),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(
      `program-cue-accelevents-${run.runId}-reconciliation.csv`,
    );
    expect(response.headers.get("x-program-cue-operation")).toBe(
      run.operationId,
    );
    const firstCsv = await response.text();
    expect(firstCsv).toContain("recordType,reportVersion,runId");
    expect(firstCsv).toContain(`run,1,${run.runId}`);
    expect(firstCsv).toContain(`item,1,${run.runId}`);
    expect(firstCsv).toContain("dry_run");
    expect(firstCsv).toContain("'=unsafe-label");

    await workerEnv.DB.prepare(
      `INSERT INTO integration_entity_mappings (
         id, connection_id, entity_type, entity_id, external_id, source_hash,
         metadata_json, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'changed-after-run', ?, ?, unixepoch(),
                 unixepoch(), unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        firstItem!.connectionId,
        firstItem!.entityType,
        firstItem!.entityId,
        String(diff.sourceHash),
        JSON.stringify({ payload: diff.payload }),
      )
      .run();
    const repeated = await loader({
      request: request("administrator", run.runId),
      params: { runId: run.runId },
      context: context(),
    } as never);
    expect(await repeated.text()).toBe(firstCsv);
  });

  it("requires an authorised event administrator and a terminal run", async () => {
    const run = await terminalDryRun();
    await expect(
      new AcceleventsReconciliationReportService(workerEnv).create(
        {
          personId: "person-demo-admin",
          name: "Olivia Bennett",
          email: "olivia@example.com",
          role: "administrator",
          organisationId: "org-future-events",
          eventId: "event-outside-current-scope",
          demo: true,
        },
        run.runId,
      ),
    ).rejects.toBeInstanceOf(AcceleventsReconciliationReportNotFoundError);
    await expect(
      loader({
        request: request("speaker", run.runId),
        params: { runId: run.runId },
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        "UPDATE integration_runs SET status = 'running', completed_at = NULL WHERE id = ?",
      ).bind(run.runId),
      workerEnv.DB.prepare(
        "UPDATE operation_jobs SET status = 'running', completed_at = NULL WHERE id = ?",
      ).bind(run.operationId),
    ]);
    await expect(
      loader({
        request: request("administrator", run.runId),
        params: { runId: run.runId },
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 409 });
  });
});
