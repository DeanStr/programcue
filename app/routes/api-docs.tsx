import { useEffect, useState } from "react";
import { Link } from "react-router";
import { getCloudflareContext } from "~/platform/cloudflare-context";
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

function ApiReferenceNavigation({
  backLink,
}: {
  backLink: { label: string; to: string };
}) {
  return (
    <nav aria-label="API reference">
      <Link className="api-reference-back" to={backLink.to}>
        ← {backLink.label}
      </Link>
    </nav>
  );
}

function ApiReferenceLoading() {
  return (
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
  );
}

export default function ApiDocs({ loaderData }: Route.ComponentProps) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return (
      <main id="main" className="api-reference-page" tabIndex={-1}>
        <ApiReferenceNavigation backLink={loaderData.backLink} />
        <ApiReferenceLoading />
      </main>
    );
  }

  return (
    <div id="main" className="api-reference-page" tabIndex={-1}>
      <ApiReferenceNavigation backLink={loaderData.backLink} />
      <ApiReferenceClient />
    </div>
  );
}
