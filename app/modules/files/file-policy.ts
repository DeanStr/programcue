import { z } from "zod";

export const assetKindSchema = z.enum([
  "headshot",
  "slides",
  "video",
  "supporting_document",
  "resource_attachment",
  "task_evidence",
  "other",
]);

export type AssetKind = z.infer<typeof assetKindSchema>;

type FilePolicy = {
  extensions: ReadonlySet<string>;
  contentTypes: ReadonlySet<string>;
};

export const FILE_SIZE_MIB = 1_048_576;
export const CANONICAL_EVENT_FILE_POLICY = {
  headshotMaximumBytes: 10 * FILE_SIZE_MIB,
  slidesMaximumBytes: 100 * FILE_SIZE_MIB,
  supportingDocumentMaximumBytes: 100 * FILE_SIZE_MIB,
  videoMaximumBytes: 1_024 * FILE_SIZE_MIB,
} as const;

const boundedMaximumBytes = (maximum: number) =>
  z.number().int().min(FILE_SIZE_MIB).max(maximum).multipleOf(FILE_SIZE_MIB);

export const eventFilePolicySchema = z
  .object({
    headshotMaximumBytes: boundedMaximumBytes(
      CANONICAL_EVENT_FILE_POLICY.headshotMaximumBytes,
    ),
    slidesMaximumBytes: boundedMaximumBytes(
      CANONICAL_EVENT_FILE_POLICY.slidesMaximumBytes,
    ),
    supportingDocumentMaximumBytes: boundedMaximumBytes(
      CANONICAL_EVENT_FILE_POLICY.supportingDocumentMaximumBytes,
    ),
    videoMaximumBytes: boundedMaximumBytes(
      CANONICAL_EVENT_FILE_POLICY.videoMaximumBytes,
    ),
  })
  .strict();

export type EventFilePolicy = z.infer<typeof eventFilePolicySchema>;

export const CANONICAL_EVENT_FILE_POLICY_JSON = JSON.stringify(
  CANONICAL_EVENT_FILE_POLICY,
);

export function parseEventFilePolicy(value: string): EventFilePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new FilePolicyError("The event file policy contains invalid JSON.", {
      cause: error,
    });
  }
  const result = eventFilePolicySchema.safeParse(parsed);
  if (!result.success)
    throw new FilePolicyError(
      "The event file policy is missing or exceeds the supported upload limits.",
      { cause: result.error },
    );
  return result.data;
}

export function maximumBytesForAssetKind(
  kind: AssetKind,
  policy: EventFilePolicy,
) {
  switch (kind) {
    case "headshot":
      return policy.headshotMaximumBytes;
    case "slides":
      return policy.slidesMaximumBytes;
    case "video":
      return policy.videoMaximumBytes;
    case "supporting_document":
    case "resource_attachment":
    case "task_evidence":
    case "other":
      return policy.supportingDocumentMaximumBytes;
  }
}

function maximumBytesForFileDeclaration(
  kind: AssetKind,
  contentType: string,
  policy: EventFilePolicy,
) {
  if (
    kind === "task_evidence" &&
    ["video/mp4", "video/webm"].includes(contentType.toLowerCase())
  ) {
    return policy.videoMaximumBytes;
  }
  return maximumBytesForAssetKind(kind, policy);
}

export function maximumMegabytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < FILE_SIZE_MIB)
    throw new FilePolicyError(
      "The event file policy contains an invalid limit.",
    );
  return bytes / FILE_SIZE_MIB;
}

const MiB = FILE_SIZE_MIB;
export const DIRECT_MULTIPART_PART_SIZE_BYTES = 10 * MiB;
const pdf = "application/pdf";
const ppt = "application/vnd.ms-powerpoint";
const pptx =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const doc = "application/msword";
const docx =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const xls = "application/vnd.ms-excel";
const xlsx =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const policies: Record<AssetKind, FilePolicy> = {
  headshot: {
    extensions: new Set(["jpg", "jpeg", "png", "webp"]),
    contentTypes: new Set(["image/jpeg", "image/png", "image/webp"]),
  },
  slides: {
    extensions: new Set(["pdf", "ppt", "pptx"]),
    contentTypes: new Set([pdf, ppt, pptx]),
  },
  video: {
    extensions: new Set(["mp4", "webm"]),
    contentTypes: new Set(["video/mp4", "video/webm"]),
  },
  supporting_document: {
    extensions: new Set(["pdf", "doc", "docx", "xls", "xlsx", "zip"]),
    contentTypes: new Set([
      pdf,
      doc,
      docx,
      xls,
      xlsx,
      "application/zip",
      "application/x-zip-compressed",
    ]),
  },
  resource_attachment: {
    extensions: new Set(["pdf", "doc", "docx", "xls", "xlsx", "zip"]),
    contentTypes: new Set([
      pdf,
      doc,
      docx,
      xls,
      xlsx,
      "application/zip",
      "application/x-zip-compressed",
    ]),
  },
  task_evidence: {
    extensions: new Set([
      "pdf",
      "ppt",
      "pptx",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "zip",
      "jpg",
      "jpeg",
      "png",
      "webp",
      "mp4",
      "webm",
    ]),
    contentTypes: new Set([
      pdf,
      ppt,
      pptx,
      doc,
      docx,
      xls,
      xlsx,
      "application/zip",
      "application/x-zip-compressed",
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
    ]),
  },
  other: {
    extensions: new Set([
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "zip",
      "jpg",
      "jpeg",
      "png",
      "webp",
    ]),
    contentTypes: new Set([
      pdf,
      doc,
      docx,
      xls,
      xlsx,
      "application/zip",
      "application/x-zip-compressed",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
  },
};

export class FilePolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilePolicyError";
  }
}

type FileDeclaration = Pick<File, "name" | "size" | "type">;

const UNSAFE_FILENAME_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Upload names reject ASCII controls, Unicode bidi overrides, and path separators.
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/u;

function extension(filename: string) {
  return filename.toLowerCase().split(".").at(-1) ?? "";
}

function assertSafeUploadFilename(filename: string) {
  if (
    !filename.trim() ||
    filename !== filename.trim() ||
    UNSAFE_FILENAME_CHARACTERS.test(filename) ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new FilePolicyError("The file name contains unsupported characters.");
  }
}

function validateDeclaredFile(
  kind: AssetKind,
  file: FileDeclaration,
  eventPolicy: EventFilePolicy,
) {
  const policy = policies[kind];
  if (!file.name || file.size <= 0)
    throw new FilePolicyError("Choose a non-empty file.");
  assertSafeUploadFilename(file.name);
  if (!policy.extensions.has(extension(file.name)))
    throw new FilePolicyError(
      `The file extension is not allowed for ${kind.replaceAll("_", " ")}.`,
    );
  if (!policy.contentTypes.has(file.type.toLowerCase()))
    throw new FilePolicyError(
      `The declared file type ${file.type || "unknown"} is not allowed.`,
    );
  const maximumBytes = maximumBytesForFileDeclaration(
    kind,
    file.type,
    eventPolicy,
  );
  if (file.size > maximumBytes)
    throw new FilePolicyError(
      `The file exceeds the ${maximumMegabytes(maximumBytes)} MB event limit.`,
    );
}

export function validateDirectFileDeclaration(
  kind: AssetKind,
  file: FileDeclaration,
  eventPolicy: EventFilePolicy,
) {
  validateDeclaredFile(kind, file, eventPolicy);
}

export type FileInspectionSource = FileDeclaration & {
  readRange(start: number, end: number): Promise<ArrayBuffer>;
};

function browserFileInspectionSource(file: File): FileInspectionSource {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    readRange: (start, end) => file.slice(start, end).arrayBuffer(),
  };
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

const zipEndOfCentralDirectory = 0x06054b50;
const zipCentralDirectoryHeader = 0x02014b50;
const compoundFileFreeSector = 0xffffffff;
const compoundFileEndOfChain = 0xfffffffe;

function uint32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

async function zipEntryNames(file: FileInspectionSource) {
  const tailSize = Math.min(file.size, 65_557);
  const tail = new Uint8Array(
    await file.readRange(file.size - tailSize, file.size),
  );
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (uint32(tailView, offset) === zipEndOfCentralDirectory) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return null;
  if (
    tailView.getUint16(endOffset + 4, true) !== 0 ||
    tailView.getUint16(endOffset + 6, true) !== 0
  )
    return null;
  const entries = tailView.getUint16(endOffset + 10, true);
  const centralSize = uint32(tailView, endOffset + 12);
  const centralOffset = uint32(tailView, endOffset + 16);
  if (
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralSize > 8 * MiB ||
    centralOffset + centralSize > file.size
  )
    return null;
  const central = new Uint8Array(
    await file.readRange(centralOffset, centralOffset + centralSize),
  );
  const view = new DataView(
    central.buffer,
    central.byteOffset,
    central.byteLength,
  );
  const names = new Set<string>();
  let offset = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > central.byteLength) return null;
    if (uint32(view, offset) !== zipCentralDirectoryHeader) return null;
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + filenameLength + extraLength + commentLength;
    if (next > central.byteLength) return null;
    names.add(
      new TextDecoder()
        .decode(central.slice(offset + 46, offset + 46 + filenameLength))
        .replaceAll("\\", "/")
        .toLowerCase(),
    );
    offset = next;
  }
  return offset === central.byteLength ? names : null;
}

function openXmlContentType(names: Set<string>) {
  if (!names.has("[content_types].xml") || !names.has("_rels/.rels"))
    return null;
  const candidates = [
    names.has("ppt/presentation.xml") ? pptx : null,
    names.has("word/document.xml") ? docx : null,
    names.has("xl/workbook.xml") ? xlsx : null,
  ].filter((value): value is string => value !== null);
  return candidates.length === 1 ? candidates[0] : null;
}

async function compoundFileStreamNames(file: FileInspectionSource) {
  const header = new Uint8Array(await file.readRange(0, 512));
  if (
    header.byteLength !== 512 ||
    !startsWith(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  )
    return null;
  const headerView = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  if (headerView.getUint16(28, true) !== 0xfffe) return null;
  const sectorShift = headerView.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const sectorSize = 2 ** sectorShift;
  const totalSectors = Math.floor(file.size / sectorSize) - 1;
  const numberOfFatSectors = uint32(headerView, 44);
  if (numberOfFatSectors < 1 || numberOfFatSectors > totalSectors) return null;

  const validSector = (sectorId: number) =>
    sectorId >= 0 && sectorId < totalSectors;
  const readSector = async (sectorId: number) => {
    if (!validSector(sectorId)) return null;
    const start = (sectorId + 1) * sectorSize;
    const bytes = new Uint8Array(
      await file.readRange(start, start + sectorSize),
    );
    return bytes.byteLength === sectorSize ? bytes : null;
  };

  const fatSectorIds: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const sectorId = uint32(headerView, 76 + index * 4);
    if (sectorId !== compoundFileFreeSector) fatSectorIds.push(sectorId);
  }
  let difatSector = uint32(headerView, 68);
  const numberOfDifatSectors = uint32(headerView, 72);
  const visitedDifat = new Set<number>();
  for (let index = 0; index < numberOfDifatSectors; index += 1) {
    if (!validSector(difatSector) || visitedDifat.has(difatSector)) return null;
    visitedDifat.add(difatSector);
    const bytes = await readSector(difatSector);
    if (!bytes) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = sectorSize / 4 - 1;
    for (let entry = 0; entry < entries; entry += 1) {
      const sectorId = uint32(view, entry * 4);
      if (sectorId !== compoundFileFreeSector) fatSectorIds.push(sectorId);
    }
    difatSector = uint32(view, sectorSize - 4);
  }
  if (
    fatSectorIds.length < numberOfFatSectors ||
    fatSectorIds.slice(0, numberOfFatSectors).some((id) => !validSector(id))
  )
    return null;
  fatSectorIds.length = numberOfFatSectors;

  const fatCache = new Map<number, Uint8Array>();
  const nextSector = async (sectorId: number) => {
    const entriesPerSector = sectorSize / 4;
    const fatIndex = Math.floor(sectorId / entriesPerSector);
    if (fatIndex >= fatSectorIds.length) return compoundFileFreeSector;
    let fatBytes = fatCache.get(fatIndex);
    if (!fatBytes) {
      fatBytes = (await readSector(fatSectorIds[fatIndex])) ?? undefined;
      if (!fatBytes) return compoundFileFreeSector;
      fatCache.set(fatIndex, fatBytes);
    }
    return uint32(
      new DataView(fatBytes.buffer, fatBytes.byteOffset, fatBytes.byteLength),
      (sectorId % entriesPerSector) * 4,
    );
  };

  const names = new Set<string>();
  const visitedDirectory = new Set<number>();
  let directorySector = uint32(headerView, 48);
  while (directorySector !== compoundFileEndOfChain) {
    if (!validSector(directorySector) || visitedDirectory.has(directorySector))
      return null;
    visitedDirectory.add(directorySector);
    const bytes = await readSector(directorySector);
    if (!bytes) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 128 <= sectorSize; offset += 128) {
      const nameLength = view.getUint16(offset + 64, true);
      const objectType = bytes[offset + 66];
      if (
        objectType === 2 &&
        nameLength >= 2 &&
        nameLength <= 64 &&
        nameLength % 2 === 0
      ) {
        names.add(
          new TextDecoder("utf-16le")
            .decode(bytes.slice(offset, offset + nameLength - 2))
            .toLowerCase(),
        );
      }
    }
    directorySector = await nextSector(directorySector);
  }
  return names;
}

function legacyOfficeContentType(names: Set<string>) {
  const candidates = [
    names.has("powerpoint document") ? ppt : null,
    names.has("worddocument") ? doc : null,
    names.has("workbook") || names.has("book") ? xls : null,
  ].filter((value): value is string => value !== null);
  return candidates.length === 1 ? candidates[0] : null;
}

export async function detectInspectionContentType(
  file: FileInspectionSource,
): Promise<string | null> {
  const bytes = new Uint8Array(await file.readRange(0, 16));
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-")
    return "application/pdf";
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    const names = await zipEntryNames(file);
    return names ? (openXmlContentType(names) ?? "application/zip") : null;
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const names = await compoundFileStreamNames(file);
    return names ? legacyOfficeContentType(names) : null;
  }
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return "video/mp4";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

export async function detectContentType(file: File): Promise<string | null> {
  return detectInspectionContentType(browserFileInspectionSource(file));
}

export function validateFileSignature(
  kind: AssetKind,
  file: FileDeclaration,
  detected: string | null,
) {
  if (!detected)
    throw new FilePolicyError("The file signature could not be recognised.");
  const declared = file.type.toLowerCase();
  const declarationMatches =
    detected === declared ||
    (detected === "application/zip" &&
      ["application/zip", "application/x-zip-compressed"].includes(declared));
  if (!declarationMatches)
    throw new FilePolicyError(
      "The file contents do not match the declared type.",
    );
  if (kind === "headshot" && !detected.startsWith("image/"))
    throw new FilePolicyError("Headshots must contain a supported image.");
  if (
    kind === "slides" &&
    !(detected === pdf || detected === ppt || detected === pptx)
  )
    throw new FilePolicyError("Slides must contain PDF, PPT or PPTX data.");
}

export function safeDownloadName(filename: string) {
  return (
    filename
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Download names neutralize ASCII controls and Unicode bidi overrides.
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069"\\/]/gu, "_")
      .slice(0, 180)
      .trim() || "download"
  );
}
