import {
  ResponseBodyTooLargeError,
  readBoundedResponseText,
} from "~/platform/http/read-response";
import { isMissingR2MultipartUpload } from "./file-service-errors";
import {
  FileMultipartIncompleteError,
  FileMultipartStateError,
} from "./multipart-upload-errors";
import {
  presignR2S3Request,
  R2S3ConfigurationError,
} from "./r2-s3-signing.server";

export type MultipartProviderRow = {
  objectKey: string;
  uploadId: string;
  sizeBytes: number;
  partSizeBytes: number;
  contentType: string;
  eventId: string;
  assetId: string;
  versionId: string;
};

export type MultipartProviderPart = {
  partNumber: number;
  etag: string;
};

function expectedPartCount(
  row: Pick<MultipartProviderRow, "sizeBytes" | "partSizeBytes">,
) {
  return Math.ceil(row.sizeBytes / row.partSizeBytes);
}

function decodeXmlText(value: string) {
  return value.replace(
    /&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      const named: Record<string, string> = {
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&amp;": "&",
      };
      const normalized = entity.toLowerCase();
      if (named[normalized] !== undefined) return named[normalized];
      const hexadecimal = normalized.startsWith("&#x");
      const raw = normalized.slice(hexadecimal ? 3 : 2, -1);
      const codePoint = Number.parseInt(raw, hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function xmlElement(source: string, name: string) {
  const match = source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXmlText(match[1]!.trim()) : null;
}

function parseR2ListParts(
  xml: string,
  row: Pick<MultipartProviderRow, "sizeBytes" | "partSizeBytes">,
) {
  if (xml.length > 2_000_000)
    throw new FileMultipartStateError(
      "R2 returned an unexpectedly large multipart part list.",
    );
  if (xmlElement(xml, "IsTruncated") !== "false")
    throw new FileMultipartStateError(
      "R2 returned an incomplete multipart part list.",
    );
  const parts: Array<{ PartNumber: number; Size: number; ETag: string }> = [];
  for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const source = match[1]!;
    const partNumber = Number(xmlElement(source, "PartNumber"));
    const size = Number(xmlElement(source, "Size"));
    const etag = xmlElement(source, "ETag");
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > expectedPartCount(row) ||
      !Number.isInteger(size) ||
      size < 1 ||
      !etag ||
      !/^[\x21-\x7e]{1,200}$/.test(etag)
    )
      throw new FileMultipartStateError(
        "R2 returned invalid multipart part metadata.",
      );
    const expectedSize = Math.min(
      row.partSizeBytes,
      row.sizeBytes - (partNumber - 1) * row.partSizeBytes,
    );
    if (size !== expectedSize)
      throw new FileMultipartStateError(
        `R2 part ${partNumber} does not match the declared upload chunk size.`,
      );
    parts.push({ PartNumber: partNumber, Size: size, ETag: etag });
  }
  parts.sort((left, right) => left.PartNumber - right.PartNumber);
  parts.forEach((part, index) => {
    if (index > 0 && parts[index - 1]!.PartNumber === part.PartNumber)
      throw new FileMultipartStateError(
        "R2 returned duplicate multipart part metadata.",
      );
  });
  return parts;
}

export class MultipartR2Provider {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies?: { fetch?: typeof fetch },
  ) {
    this.fetcher = dependencies?.fetch ?? fetch;
  }

  requireBucket() {
    if (!this.env.FILES)
      throw new R2S3ConfigurationError(
        "Required private R2 binding FILES is unavailable.",
      );
    return this.env.FILES;
  }

  createUpload(
    row: Omit<MultipartProviderRow, "uploadId">,
  ): Promise<R2MultipartUpload> {
    return this.requireBucket().createMultipartUpload(row.objectKey, {
      httpMetadata: { contentType: row.contentType },
      customMetadata: {
        eventId: row.eventId,
        assetId: row.assetId,
        versionId: row.versionId,
        quarantine: "pending-scan",
      },
    });
  }

  async listParts(row: MultipartProviderRow) {
    const url = await presignR2S3Request({
      env: this.env,
      method: "GET",
      objectKey: row.objectKey,
      query: {
        uploadId: row.uploadId,
        "max-parts": String(Math.min(expectedPartCount(row), 1_000)),
      },
      expiresSeconds: 60,
    });
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { accept: "application/xml" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new FileMultipartIncompleteError(
        "R2 could not list the uploaded parts. Retry resume.",
        false,
        { cause: error },
      );
    }
    if (response.status === 404)
      throw new FileMultipartStateError(
        "R2 no longer has this multipart upload. Abort it and begin a new upload.",
      );
    if (!response.ok)
      throw new FileMultipartIncompleteError(
        `R2 could not list the uploaded parts (${response.status}). Retry resume.`,
        false,
      );
    let xml: string;
    try {
      xml = await readBoundedResponseText(response, 2_000_000);
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError)
        throw new FileMultipartStateError(
          "R2 returned an unexpectedly large multipart part list.",
          { cause: error },
        );
      throw error;
    }
    return parseR2ListParts(xml, row);
  }

  createPartUrl(row: MultipartProviderRow, partNumber: number) {
    return presignR2S3Request({
      env: this.env,
      method: "PUT",
      objectKey: row.objectKey,
      query: { partNumber: String(partNumber), uploadId: row.uploadId },
      expiresSeconds: 900,
    });
  }

  async complete(row: MultipartProviderRow, parts: MultipartProviderPart[]) {
    const bucket = this.requireBucket();
    let object = await bucket.head(row.objectKey);
    if (object) return object;
    try {
      await bucket
        .resumeMultipartUpload(row.objectKey, row.uploadId)
        .complete(parts);
    } catch (error) {
      object = await bucket.head(row.objectKey);
      if (!object) throw error;
      return object;
    }
    object = await bucket.head(row.objectKey);
    if (!object)
      throw new FileMultipartIncompleteError(
        "R2 multipart completion returned before the completed object became readable. Retry with the same part manifest.",
        true,
      );
    return object;
  }

  async abort(row: Pick<MultipartProviderRow, "objectKey" | "uploadId">) {
    try {
      await this.requireBucket()
        .resumeMultipartUpload(row.objectKey, row.uploadId)
        .abort();
      return true;
    } catch (error) {
      if (isMissingR2MultipartUpload(error)) return true;
      throw error;
    }
  }

  delete(objectKey: string) {
    return this.requireBucket().delete(objectKey);
  }
}
