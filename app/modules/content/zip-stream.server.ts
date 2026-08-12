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
    value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
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
  object: R2ObjectBody;
  modifiedAt: number;
};

export function createStoredZipStream(entries: StoredZipEntry[]) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let offset = 0;
        const central: Uint8Array[] = [];
        for (const entry of entries) {
          const name = encoder.encode(entry.path);
          if (name.length === 0 || name.length > 0xffff) {
            throw new Error("A ZIP entry has an invalid path length.");
          }
          const entryOffset = offset;
          const header = localHeader(name, entry.modifiedAt);
          controller.enqueue(header);
          offset += header.length;
          let crc = 0xffffffff;
          let size = 0;
          const reader = entry.object.body.getReader();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            crc = crc32(crc, result.value);
            size += result.value.length;
            controller.enqueue(result.value);
            offset += result.value.length;
          }
          crc = (crc ^ 0xffffffff) >>> 0;
          if (size !== entry.object.size) {
            throw new Error(
              `Private file ${entry.path} changed during ZIP generation.`,
            );
          }
          const descriptor = dataDescriptor(crc, size);
          controller.enqueue(descriptor);
          offset += descriptor.length;
          central.push(
            centralHeader({
              name,
              modifiedAt: entry.modifiedAt,
              crc,
              size,
              offset: entryOffset,
            }),
          );
        }
        const centralOffset = offset;
        for (const header of central) {
          controller.enqueue(header);
          offset += header.length;
        }
        const centralSize = offset - centralOffset;
        controller.enqueue(
          endOfCentralDirectory(entries.length, centralSize, centralOffset),
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
