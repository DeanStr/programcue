import { z } from "zod";
import {
  ADMIN_SUBMISSION_PAGE_SIZE,
  ADMIN_SUBMISSION_SORTS,
  ADMIN_SUBMISSION_STATUSES,
  type AdminSubmissionFilters,
} from "./submission-repository-shared";

export const ADMIN_SUBMISSION_OPTIONAL_COLUMNS = [
  "submitter",
  "route",
  "speakers",
  "status",
] as const;

export type AdminSubmissionOptionalColumn =
  (typeof ADMIN_SUBMISSION_OPTIONAL_COLUMNS)[number];
export type AdminSubmissionDensity = "comfortable" | "compact";

export type AdminSubmissionView = {
  filters: AdminSubmissionFilters;
  page: number;
  columns: AdminSubmissionOptionalColumn[];
  density: AdminSubmissionDensity;
};

const statusSchema = z.enum(ADMIN_SUBMISSION_STATUSES);
const routingSchema = z.enum(["missing_automatic", "manual_override"]);
const sortSchema = z.enum(ADMIN_SUBMISSION_SORTS);
const densitySchema = z.enum(["comfortable", "compact"]);
const optionalColumnSchema = z.enum(ADMIN_SUBMISSION_OPTIONAL_COLUMNS);

function singleParameter(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new Response(`Duplicate submissions parameter: ${name}`, {
      status: 400,
    });
  }
  return values[0];
}

function optionalParameter<T>(
  url: URL,
  name: string,
  parser: { safeParse(value: string): { success: boolean; data?: T } },
) {
  const value = singleParameter(url, name);
  if (value === undefined || value === "") return undefined;
  const parsed = parser.safeParse(value);
  if (!parsed.success) {
    throw new Response(`Invalid submissions parameter: ${name}`, {
      status: 400,
    });
  }
  return parsed.data;
}

export function parseAdminSubmissionView(url: URL): AdminSubmissionView {
  const pageValue = singleParameter(url, "page") ?? "1";
  if (!/^[1-9]\d*$/.test(pageValue)) {
    throw new Response("Invalid submissions parameter: page", { status: 400 });
  }
  const page = Number(pageValue);
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(page * ADMIN_SUBMISSION_PAGE_SIZE)
  ) {
    throw new Response("Invalid submissions parameter: page", { status: 400 });
  }

  const query = singleParameter(url, "query") ?? "";
  const category = singleParameter(url, "category") ?? "";
  if (query.length > 200) {
    throw new Response("Invalid submissions parameter: query", { status: 400 });
  }
  if (category.length > 120) {
    throw new Response("Invalid submissions parameter: category", {
      status: 400,
    });
  }

  const columnsValue = singleParameter(url, "columns");
  const columns =
    columnsValue === undefined
      ? [...ADMIN_SUBMISSION_OPTIONAL_COLUMNS]
      : columnsValue === ""
        ? []
        : columnsValue.split(",").map((column) => {
            const parsed = optionalColumnSchema.safeParse(column);
            if (!parsed.success) {
              throw new Response("Invalid submissions parameter: columns", {
                status: 400,
              });
            }
            return parsed.data;
          });
  if (new Set(columns).size !== columns.length) {
    throw new Response("Invalid submissions parameter: columns", {
      status: 400,
    });
  }

  return {
    page,
    columns,
    density: optionalParameter(url, "density", densitySchema) ?? "comfortable",
    filters: {
      status: optionalParameter(url, "status", statusSchema) ?? "",
      category,
      query,
      routing: optionalParameter(url, "routing", routingSchema) ?? "",
      sort: optionalParameter(url, "sort", sortSchema) ?? "submittedAt-desc",
    },
  };
}

export function adminSubmissionSearchParams(
  view: AdminSubmissionView,
  page = view.page,
) {
  const search = new URLSearchParams();
  if (page !== 1) search.set("page", String(page));
  for (const key of ["status", "category", "query", "routing"] as const) {
    const value = view.filters[key];
    if (value) search.set(key, value);
  }
  if (view.filters.sort !== "submittedAt-desc") {
    search.set("sort", view.filters.sort ?? "submittedAt-desc");
  }
  if (
    view.columns.length !== ADMIN_SUBMISSION_OPTIONAL_COLUMNS.length ||
    view.columns.some(
      (column, index) => column !== ADMIN_SUBMISSION_OPTIONAL_COLUMNS[index],
    )
  ) {
    search.set("columns", view.columns.join(","));
  }
  if (view.density !== "comfortable") search.set("density", view.density);
  return search;
}
