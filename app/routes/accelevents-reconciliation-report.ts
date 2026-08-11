import type { LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";

import {
  AcceleventsReconciliationReportNotFoundError,
  AcceleventsReconciliationReportService,
  AcceleventsReconciliationReportUnavailableError,
} from "~/modules/integrations/accelevents-reconciliation-report.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  try {
    const report = await new AcceleventsReconciliationReportService(env).create(
      viewer,
      params.runId ?? "",
    );
    return new Response(report.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${report.filename}"`,
        "cache-control": "private, no-store",
        "x-program-cue-operation": report.operationId,
      },
    });
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof AcceleventsReconciliationReportNotFoundError
    )
      throw new Response("Accelevents reconciliation run not found", {
        status: 404,
      });
    if (error instanceof AcceleventsReconciliationReportUnavailableError)
      throw new Response(error.message, { status: 409 });
    throw error;
  }
}
