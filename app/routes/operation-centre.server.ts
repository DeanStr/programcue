import { data, redirect } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/operation-centre";
import {
  AirtableProjectionRecoveryError,
  AirtableProjectionRecoveryService,
} from "~/modules/airtable/airtable-projection-recovery-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { CsvParseError } from "~/platform/operations/csv";
import {
  DataImportService,
  DataImportStateError,
} from "~/platform/operations/data-import-service.server";
import {
  OperationNotFoundError,
  OperationQueueUnavailableError,
  OperationService,
  OperationStateError,
  activityAreas,
} from "~/platform/operations/operation-service.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";

const exportResources = [
  "people",
  "submissions",
  "sessions",
  "rooms",
  "tracks",
  "tasks",
  "audit",
] as const;

const FAILURE_PAGE_SIZE = 50;

function failurePageFromSearch(search: URLSearchParams, status: string) {
  const rawPage = search.get("page");
  if (status !== "failed") {
    if (rawPage !== null) {
      throw new Response("Operation pages require the failed status filter.", {
        status: 400,
      });
    }
    return 1;
  }
  if (rawPage === null) return 1;
  if (!/^[1-9]\d*$/.test(rawPage)) {
    throw new Response("Failure page must be a positive integer.", {
      status: 400,
    });
  }
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page)) {
    throw new Response("Failure page is too large.", { status: 400 });
  }
  return page;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  // Capture the invalidation boundary before reading the snapshot. A change
  // committed while the remaining queries run will then have a newer cursor
  // and force the browser to revalidate rather than being silently missed.
  const cursor = await new EventRealtimeService(env).getLatestCursor(viewer);
  const service = new OperationService(env);
  const search = new URL(request.url).searchParams;
  const status = search.get("status") ?? "";
  const type = search.get("type") ?? "";
  const operationId = search.get("operation") ?? "";
  const panel = search.get("panel") ?? "";
  const failurePage = failurePageFromSearch(search, status);
  const operationRead =
    status === "failed"
      ? service.listFailurePage(viewer, {
          page: failurePage,
          pageSize: FAILURE_PAGE_SIZE,
          type,
        })
      : service.list(viewer);
  const [operationResult, airtableRecoveries, eventTimezone] =
    await Promise.all([
      operationRead,
      new AirtableProjectionRecoveryService(env).list(viewer),
      service.eventTimezone(viewer),
    ]);
  const failurePagination = Array.isArray(operationResult)
    ? null
    : {
        page: operationResult.page,
        pageSize: operationResult.pageSize,
        total: operationResult.total,
        from: operationResult.from,
        to: operationResult.to,
        hasPrevious: operationResult.hasPrevious,
        hasNext: operationResult.hasNext,
      };
  const operations = Array.isArray(operationResult)
    ? operationResult
    : operationResult.items;
  const activityFilters = {
    area: search.get("activityArea") ?? "",
    actorPersonId: search.get("activityActor") ?? "",
    query: search.get("activityQuery") ?? "",
  };
  const activity =
    panel === "activity" ? await service.activity(viewer, activityFilters) : [];
  const listedSelection = operations.find(
    (operation) => operation.id === operationId,
  );
  const [selectedOperation, operationDetail] = operationId
    ? await Promise.all([
        listedSelection ?? service.find(viewer, operationId),
        service.detail(viewer, operationId),
      ])
    : [null, null];
  const candidates =
    selectedOperation && !listedSelection
      ? [selectedOperation, ...operations]
      : operations;
  const visible = candidates.filter((operation) => {
    const statusMatches =
      !status ||
      (status === "failed"
        ? ["queue_failed", "failed", "partially_failed"].includes(
            operation.status,
          )
        : operation.status === status);
    return (
      statusMatches &&
      (!type || operation.type === type) &&
      (!operationId || operation.id === operationId)
    );
  });
  return {
    operations: visible,
    operationDetail,
    selectedOperation,
    selectedOperationId: operationId,
    types: [
      ...new Set([
        ...candidates.map((operation) => operation.type),
        ...(type ? [type] : []),
      ]),
    ].sort(),
    filters: { status, type },
    failurePagination,
    panel,
    activity,
    activityAreas,
    activityActors: [
      ...new Map(
        activity
          .filter((item) => item.actorPersonId)
          .map((item) => [
            item.actorPersonId!,
            { id: item.actorPersonId!, name: item.actorName },
          ]),
      ).values(),
    ].sort((left, right) => left.name.localeCompare(right.name)),
    activityFilters,
    filterActive: Boolean(status || type || operationId),
    eventId: viewer.eventId,
    eventTimezone,
    cursor,
    airtableRecoveries,
    canExportData: viewer.role === "owner",
    exportIntents: Object.fromEntries(
      exportResources.map((resource) => [resource, crypto.randomUUID()]),
    ) as Record<(typeof exportResources)[number], string>,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "preview-import") {
    const file = form.get("csv");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) {
      return data(
        {
          ok: false as const,
          committed: false as const,
          operationId: "",
          message: "Choose a .csv file to preview.",
        },
        { status: 422 },
      );
    }
    if (file.size > 512_000) {
      return data(
        {
          ok: false as const,
          committed: false as const,
          operationId: "",
          message: "CSV import files cannot exceed 512 KB.",
        },
        { status: 413 },
      );
    }
    try {
      const preview = await new DataImportService(env).preview(viewer, {
        resource: form.get("resource"),
        fileName: file.name,
        csv: await file.text(),
      });
      throw redirect(
        `/admin/operations?panel=imports&operation=${encodeURIComponent(preview.operationId)}`,
      );
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error instanceof DataImportStateError) {
        return data(
          {
            ok: false as const,
            committed: false as const,
            operationId: "",
            message: error.message,
          },
          { status: 409 },
        );
      }
      if (error instanceof ZodError || error instanceof CsvParseError) {
        return data(
          {
            ok: false as const,
            committed: false as const,
            operationId: "",
            message:
              error instanceof ZodError
                ? (error.issues[0]?.message ?? "The CSV import is invalid.")
                : error.message,
          },
          { status: 422 },
        );
      }
      throw error;
    }
  }
  if (intent === "confirm-import") {
    const operationId = String(form.get("operationId") ?? "");
    try {
      const result = await new DataImportService(env).confirm(
        viewer,
        operationId,
      );
      return data({
        ok: true as const,
        operationId,
        message: [
          `Imported ${result.rowCount} ${result.resource} records.`,
          result.webhookWarning,
        ]
          .filter(Boolean)
          .join(" "),
      });
    } catch (error) {
      if (error instanceof DataImportStateError) {
        return data(
          {
            ok: false as const,
            committed: false as const,
            operationId,
            message: error.message,
          },
          { status: 409 },
        );
      }
      throw error;
    }
  }
  if (intent === "recover-airtable-projection") {
    const operationId = String(form.get("operationId") ?? "");
    try {
      await new AirtableProjectionRecoveryService(env).recover(
        viewer,
        operationId,
      );
      return data({
        ok: true as const,
        operationId,
        message: "Airtable is back in step with Program Cue for this change.",
      });
    } catch (error) {
      if (error instanceof AirtableProjectionRecoveryError) {
        return data(
          {
            ok: false as const,
            committed: false as const,
            operationId,
            message: error.message,
          },
          { status: error.status },
        );
      }
      throw error;
    }
  }
  if (
    intent !== "retry" &&
    intent !== "cancel" &&
    intent !== "acknowledge-failure" &&
    intent !== "retry-item" &&
    intent !== "skip-item"
  )
    throw new Response("Unsupported operation", { status: 400 });
  const operationId = String(form.get("operationId") ?? "");
  if (!operationId)
    throw new Response("Operation id is required", { status: 422 });
  try {
    const service = new OperationService(env);
    if (intent === "retry") {
      await service.retry(viewer, operationId);
    } else if (intent === "cancel") {
      await service.cancel(viewer, operationId);
    } else if (intent === "acknowledge-failure") {
      const acknowledgement = await service.acknowledgeFailure(
        viewer,
        operationId,
      );
      const realtimeFailure = await notifyRouteChange(
        env,
        viewer,
        acknowledgement.changeSequence,
        operationId,
      );
      if (realtimeFailure) {
        return data({ ...realtimeFailure, operationId }, { status: 207 });
      }
    } else {
      const itemId = String(form.get("itemId") ?? "");
      if (!itemId)
        throw new Response("Operation item id is required", { status: 422 });
      if (intent === "retry-item") {
        await service.retryItem(viewer, operationId, itemId);
      } else {
        await service.skipItem(
          viewer,
          operationId,
          itemId,
          String(form.get("reason") ?? ""),
        );
      }
    }
    return data({
      ok: true as const,
      operationId,
      message:
        intent === "retry"
          ? "This operation was queued to run again."
          : intent === "cancel"
            ? "This operation was cancelled before any external work began."
            : intent === "acknowledge-failure"
              ? "The failure was acknowledged and removed from active operational alerts. Its operation and audit history remain available."
              : intent === "retry-item"
                ? "Only the selected failed Accelevents record was queued for retry."
                : "The selected Accelevents record was skipped with an audit reason.",
    });
  } catch (error) {
    if (error instanceof OperationQueueUnavailableError) {
      return data(
        {
          ok: false as const,
          committed: true as const,
          operationId: error.operationId,
          message: error.message,
        },
        { status: 503 },
      );
    }
    if (error instanceof OperationNotFoundError) {
      return data(
        {
          ok: false as const,
          committed: false as const,
          operationId,
          message: error.message,
        },
        { status: 404 },
      );
    }
    if (error instanceof OperationStateError) {
      return data(
        {
          ok: false as const,
          committed: false as const,
          operationId,
          message: error.message,
        },
        { status: 409 },
      );
    }
    throw error;
  }
}
