export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export type ParsedCsv = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

const MAX_COLUMNS = 50;
const MAX_ROWS = 200;

export function parseCsv(input: string): ParsedCsv {
  const source = input.replace(/^\uFEFF/u, "");
  if (!source.trim()) throw new CsvParseError("The CSV file is empty.");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let quotedFieldClosed = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quotedFieldClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (quotedFieldClosed) {
      if (character === ",") {
        record.push(field);
        field = "";
        quotedFieldClosed = false;
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        record.push(field);
        field = "";
        if (record.some((value) => value.length > 0)) records.push(record);
        record = [];
        quotedFieldClosed = false;
      } else {
        throw new CsvParseError(
          `Unexpected text after a closing quote in CSV row ${records.length + 1}.`,
        );
      }
      continue;
    }
    if (character === '"') {
      if (field) {
        throw new CsvParseError(
          `Unexpected quote in CSV row ${records.length + 1}.`,
        );
      }
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      field = "";
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
    } else {
      field += character;
    }
  }
  if (quoted)
    throw new CsvParseError("The CSV file ends inside a quoted field.");
  record.push(field);
  if (record.some((value) => value.length > 0)) records.push(record);
  if (!records.length) throw new CsvParseError("The CSV file is empty.");

  const headers = records[0].map((header) => header.trim());
  if (!headers.length || headers.some((header) => !header)) {
    throw new CsvParseError("Every CSV column must have a header.");
  }
  if (headers.length > MAX_COLUMNS) {
    throw new CsvParseError(
      `CSV imports support at most ${MAX_COLUMNS} columns.`,
    );
  }
  if (new Set(headers).size !== headers.length) {
    throw new CsvParseError("CSV headers must be unique.");
  }
  const body = records.slice(1);
  if (!body.length) throw new CsvParseError("The CSV file has no data rows.");
  if (body.length > MAX_ROWS) {
    throw new CsvParseError(`CSV previews support at most ${MAX_ROWS} rows.`);
  }
  return {
    headers,
    rows: body.map((values, rowIndex) => {
      if (values.length !== headers.length) {
        throw new CsvParseError(
          `CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}.`,
        );
      }
      return Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      );
    }),
  };
}
