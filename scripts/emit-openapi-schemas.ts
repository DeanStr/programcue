import { z } from "zod";

import { apiGeneratedSchemas } from "../app/platform/api/api-command-contract";

const generated = Object.fromEntries(
  Object.entries(apiGeneratedSchemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => {
      const jsonSchema = z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
      delete jsonSchema.$schema;
      return [name, jsonSchema];
    }),
);

process.stdout.write(JSON.stringify(generated));
