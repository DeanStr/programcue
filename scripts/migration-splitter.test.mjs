import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { unstable_splitSqlQuery } from "wrangler";

test("the event speaker workflow migration remains complete through Wrangler's SQL splitter", () => {
  const migration = readFileSync(
    new URL("../migrations/0011_event_speaker_workflows.sql", import.meta.url),
    "utf8",
  );
  const statements = unstable_splitSqlQuery(migration);

  assert.equal(statements.length, 7);
  assert.equal(
    statements.filter((statement) => statement.includes("CREATE TRIGGER"))
      .length,
    4,
  );
  for (const trigger of statements.filter((statement) =>
    statement.includes("CREATE TRIGGER"),
  )) {
    assert.doesNotMatch(trigger, /\bEND;/u);
  }
  assert.match(statements.at(-1), /^CREATE TRIGGER[\s\S]+END$/u);
});
