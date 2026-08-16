export type AdminRecordBreadcrumbHandle = {
  adminRecordBreadcrumbLabel(data: unknown): string | null;
};

function valueAtPath(data: unknown, path: ReadonlyArray<string>) {
  let value = data;
  for (const key of path) {
    if (!value || typeof value !== "object" || !(key in value)) {
      throw new Error("The route did not provide its record breadcrumb label.");
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("The route provided an invalid record breadcrumb label.");
  }
  return value;
}

export function adminRecordBreadcrumbHandle(
  path: ReadonlyArray<string>,
): AdminRecordBreadcrumbHandle {
  return {
    adminRecordBreadcrumbLabel: (data) => valueAtPath(data, path),
  };
}

export function adminRecordBreadcrumbLabelAtPath(
  data: unknown,
  path: ReadonlyArray<string>,
) {
  return valueAtPath(data, path);
}
