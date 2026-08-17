const encoder = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(current: number, chunk: Uint8Array) {
  let value = current;
  for (const byte of chunk)
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function uint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function uint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(epochSeconds: number) {
  const date = new Date(Math.max(epochSeconds, 315532800) * 1_000);
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

function localHeader(name: Uint8Array, modifiedAt: number) {
  const output = new Uint8Array(30 + name.length);
  const view = new DataView(output.buffer);
  const stamp = dosDateTime(modifiedAt);
  uint32(view, 0, 0x04034b50);
  uint16(view, 4, 20);
  uint16(view, 6, 0x0808);
  uint16(view, 8, 0);
  uint16(view, 10, stamp.time);
  uint16(view, 12, stamp.date);
  uint16(view, 26, name.length);
  output.set(name, 30);
  return output;
}

function dataDescriptor(crc: number, size: number) {
  const output = new Uint8Array(16);
  const view = new DataView(output.buffer);
  uint32(view, 0, 0x08074b50);
  uint32(view, 4, crc);
  uint32(view, 8, size);
  uint32(view, 12, size);
  return output;
}

function centralHeader(input: {
  name: Uint8Array;
  modifiedAt: number;
  crc: number;
  size: number;
  offset: number;
}) {
  const output = new Uint8Array(46 + input.name.length);
  const view = new DataView(output.buffer);
  const stamp = dosDateTime(input.modifiedAt);
  uint32(view, 0, 0x02014b50);
  uint16(view, 4, 20);
  uint16(view, 6, 20);
  uint16(view, 8, 0x0808);
  uint16(view, 10, 0);
  uint16(view, 12, stamp.time);
  uint16(view, 14, stamp.date);
  uint32(view, 16, input.crc);
  uint32(view, 20, input.size);
  uint32(view, 24, input.size);
  uint16(view, 28, input.name.length);
  uint32(view, 42, input.offset);
  output.set(input.name, 46);
  return output;
}

function endOfCentralDirectory(entries: number, size: number, offset: number) {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  uint32(view, 0, 0x06054b50);
  uint16(view, 8, entries);
  uint16(view, 10, entries);
  uint32(view, 12, size);
  uint32(view, 16, offset);
  return output;
}

export type StoredZipEntry = {
  path: string;
  expectedSize: number;
  modifiedAt: number;
  open: () => Promise<R2ObjectBody>;
};

export function storedZipByteLength(entries: StoredZipEntry[]) {
  return entries.reduce((total, entry) => {
    const nameLength = encoder.encode(entry.path).length;
    return total + 30 + nameLength + entry.expectedSize + 16 + 46 + nameLength;
  }, 22);
}

export function createStoredZipStream(entries: StoredZipEntry[]) {
  type CurrentEntry = {
    entry: StoredZipEntry;
    name: Uint8Array;
    offset: number;
    crc: number;
    size: number;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  };

  let entryIndex = 0;
  let offset = 0;
  let current: CurrentEntry | null = null;
  let phase: "header" | "body" | "descriptor" | "central" | "end" = "header";
  const central: Uint8Array[] = [];
  let centralIndex = 0;
  let centralOffset = 0;
  let cancelled = false;
  let cancellationReason: unknown;

  async function cancelBodies(reason?: unknown) {
    if (current) {
      await current.reader.cancel(reason).catch(() => undefined);
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (phase === "header") {
            const entry = entries[entryIndex];
            if (!entry) {
              centralOffset = offset;
              phase = "central";
              continue;
            }
            const name = encoder.encode(entry.path);
            if (name.length === 0 || name.length > 0xffff) {
              throw new Error("A ZIP entry has an invalid path length.");
            }
            const object = await entry.open();
            if (cancelled) {
              await object.body
                .cancel(cancellationReason)
                .catch(() => undefined);
              return;
            }
            if (object.size !== entry.expectedSize) {
              await object.body.cancel().catch(() => undefined);
              throw new Error(
                `Private file ${entry.path} changed during ZIP generation.`,
              );
            }
            current = {
              entry,
              name,
              offset,
              crc: 0xffffffff,
              size: 0,
              reader: object.body.getReader(),
            };
            const header = localHeader(name, entry.modifiedAt);
            offset += header.length;
            phase = "body";
            controller.enqueue(header);
            return;
          }

          if (phase === "body") {
            if (!current) throw new Error("The ZIP entry state is invalid.");
            const result = await current.reader.read();
            if (result.done) {
              current.reader.releaseLock();
              current.crc = (current.crc ^ 0xffffffff) >>> 0;
              if (current.size !== current.entry.expectedSize) {
                throw new Error(
                  `Private file ${current.entry.path} changed during ZIP generation.`,
                );
              }
              phase = "descriptor";
              continue;
            }
            if (
              current.size + result.value.length >
              current.entry.expectedSize
            ) {
              throw new Error(
                `Private file ${current.entry.path} changed during ZIP generation.`,
              );
            }
            current.crc = crc32(current.crc, result.value);
            current.size += result.value.length;
            offset += result.value.length;
            controller.enqueue(result.value);
            return;
          }

          if (phase === "descriptor") {
            if (!current) throw new Error("The ZIP entry state is invalid.");
            const descriptor = dataDescriptor(current.crc, current.size);
            central.push(
              centralHeader({
                name: current.name,
                modifiedAt: current.entry.modifiedAt,
                crc: current.crc,
                size: current.size,
                offset: current.offset,
              }),
            );
            offset += descriptor.length;
            entryIndex += 1;
            current = null;
            phase = "header";
            controller.enqueue(descriptor);
            return;
          }

          if (phase === "central") {
            const header = central[centralIndex];
            if (!header) {
              phase = "end";
              continue;
            }
            centralIndex += 1;
            offset += header.length;
            controller.enqueue(header);
            return;
          }

          controller.enqueue(
            endOfCentralDirectory(
              entries.length,
              offset - centralOffset,
              centralOffset,
            ),
          );
          controller.close();
          return;
        }
      } catch (error) {
        await cancelBodies(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      cancellationReason = reason;
      await cancelBodies(reason);
    },
  });
}
