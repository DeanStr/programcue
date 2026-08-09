import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

export default function ApiReferenceClient() {
  return <ApiReferenceReact configuration={{
    url: "/openapi.json",
    layout: "modern",
    showOperationId: true,
    documentDownloadType: "both",
    hideTestRequestButton: false,
    hideClientButton: false,
    hideModels: false,
    hideDarkModeToggle: false,
    darkMode: false,
    withDefaultFonts: false,
    agent: { disabled: true },
    metaData: { title: "Program Cue API Reference" },
  }} />;
}
