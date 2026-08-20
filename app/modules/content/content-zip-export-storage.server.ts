const ZIP_EXPORT_PREFIX = "private/events";

export const ZIP_EXPORT_TTL_SECONDS = 24 * 60 * 60;
export const ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS = 5 * 60;

export function storageKeySegment(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(
      `The ZIP export ${label} is not a safe storage identifier.`,
    );
  }
  return value;
}

export function zipExportObjectPrefix(eventId: string, operationId: string) {
  return `${ZIP_EXPORT_PREFIX}/${storageKeySegment(eventId, "event")}/exports/${storageKeySegment(operationId, "operation")}/`;
}

export function zipExportObjectKey(
  eventId: string,
  operationId: string,
  claimToken: string,
) {
  return `${zipExportObjectPrefix(eventId, operationId)}${storageKeySegment(claimToken, "claim")}.zip`;
}
