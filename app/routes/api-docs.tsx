import { useEffect, useState } from "react";
import { Link } from "react-router";

import ApiReferenceClient from "../components/api-reference.client";

import type { Route } from "./+types/api-docs";

export const meta: Route.MetaFunction = () => [
  { title: "API Reference · Program Cue" },
  {
    name: "description",
    content: "Interactive OpenAPI reference for the Program Cue API.",
  },
];

export default function ApiDocs() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <div id="main" className="api-reference-page" tabIndex={-1}>
      <nav aria-label="API reference">
        <Link className="api-reference-back" to="/evaluate">
          ← Evaluation access
        </Link>
      </nav>
      {hydrated && ApiReferenceClient ? (
        <ApiReferenceClient />
      ) : (
        <section
          aria-labelledby="api-reference-title"
          style={{ maxWidth: "40rem", margin: "12vh auto", padding: "0 24px" }}
        >
          <h1 id="api-reference-title">Program Cue API reference</h1>
          <p role="status">Loading the interactive reference…</p>
          <p>
            You can also{" "}
            <a href="/openapi.json">open the OpenAPI document directly</a>.
          </p>
        </section>
      )}
    </div>
  );
}
