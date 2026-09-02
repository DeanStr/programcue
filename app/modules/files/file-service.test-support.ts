import { env } from "cloudflare:test";

import { RouterContextProvider } from "react-router";

import type { Viewer } from "~/platform/auth/authorize.server";

import { cloudflareContext } from "~/platform/cloudflare-context";

export const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export function withSuppressedStatement(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let suppressed = 0;
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (suppressed > 0 || !pattern.test(query)) return statement;
          suppressed += 1;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") {
                return () =>
                  target.prepare(
                    "UPDATE people SET display_name = display_name WHERE 0",
                  );
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    suppressed: () => suppressed,
  };
}

export async function uploadCleanupState(
  testEnv: CloudflareEnvironment,
  upload: { assetId: string; versionId: string },
) {
  return testEnv.DB.prepare(
    `SELECT asset.status AS assetStatus,
            asset.current_version_id AS currentVersionId,
            version.upload_status AS uploadStatus,
            version.scan_status AS scanStatus,
            version.scan_error AS scanError,
            version.deleted_at AS deletedAt,
            (SELECT COUNT(*) FROM audit_events audit
              WHERE audit.id = 'file-upload-discarded:' || version.id) AS auditCount
       FROM file_assets asset
       JOIN file_versions version
         ON version.id = ? AND version.asset_id = asset.id
        AND version.event_id = asset.event_id
      WHERE asset.id = ?`,
  )
    .bind(upload.versionId, upload.assetId)
    .first();
}

export const submitterOnly: Viewer = {
  ...speaker,
  personId: "file-submit-only-person",
  email: "file-submit-only@example.com",
  role: "submitter",
};

export function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

export const ppt = "application/vnd.ms-powerpoint";

export const pptx =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function concatenate(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function emptyZip(entries: string[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const central = concatenate(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, localOffset, true);
  return concatenate([...localParts, central, end]);
}

export function compoundOfficeFile(streamName: string) {
  const bytes = new Uint8Array(1_536);
  const header = new DataView(bytes.buffer, 0, 512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.setUint16(26, 3, true);
  header.setUint16(28, 0xfffe, true);
  header.setUint16(30, 9, true);
  header.setUint16(32, 6, true);
  header.setUint32(44, 1, true);
  header.setUint32(48, 0, true);
  header.setUint32(56, 4_096, true);
  header.setUint32(60, 0xfffffffe, true);
  header.setUint32(68, 0xfffffffe, true);
  bytes.fill(0xff, 76, 512);
  header.setUint32(76, 1, true);

  const directoryOffset = 512 + 128;
  for (let index = 0; index < streamName.length; index += 1)
    new DataView(bytes.buffer).setUint16(
      directoryOffset + index * 2,
      streamName.charCodeAt(index),
      true,
    );
  const directory = new DataView(bytes.buffer, directoryOffset, 128);
  directory.setUint16(64, (streamName.length + 1) * 2, true);
  bytes[directoryOffset + 66] = 2;

  bytes.fill(0xff, 1_024, 1_536);
  const fat = new DataView(bytes.buffer, 1_024, 512);
  fat.setUint32(0, 0xfffffffe, true);
  fat.setUint32(4, 0xfffffffd, true);
  return bytes;
}
