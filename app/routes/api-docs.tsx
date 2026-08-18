import { useEffect, useState } from "react";
import { Link } from "react-router";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import "~/styles/workspace-remaining.css";
import ApiReferenceClient from "../components/api-reference.client";
import type { Route } from "./+types/api-docs";
import { apiReferenceBackLink } from "./api-docs-navigation.server";

export const meta: Route.MetaFunction = () => [
  { title: "API Reference · Program Cue" },
  {
    name: "description",
    content: "Interactive OpenAPI reference for the Program Cue API.",
  },
];

export function loader({ context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  return { backLink: apiReferenceBackLink(env) };
}

function ApiReferenceChrome({
  backLink,
}: {
  backLink: { label: string; to: string };
}) {
  return (
    <header className="pc-api-chrome">
      <h1 id="api-reference-title">Program Cue API reference</h1>
      <nav aria-label="API reference">
        <Link className="api-reference-back" to={backLink.to}>
          ← {backLink.label}
        </Link>
      </nav>
    </header>
  );
}

function ApiReferenceLoading() {
  return (
    <section aria-labelledby="api-reference-title" className="pc-api-loading">
      <p role="status">Loading the interactive reference…</p>
      <p>
        You can also{" "}
        <a href="/openapi.json">open the OpenAPI document directly</a>.
      </p>
    </section>
  );
}

export default function ApiDocs({ loaderData }: Route.ComponentProps) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <main id="main" className="api-reference-page pc-api" tabIndex={-1}>
      <ApiReferenceChrome backLink={loaderData.backLink} />
      {hydrated ? <ApiReferenceClient /> : <ApiReferenceLoading />}
    </main>
  );
}
