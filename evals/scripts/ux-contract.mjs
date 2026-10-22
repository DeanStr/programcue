import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const surfaces = [
  { id: "command", route: "/admin/command", heading: "Command Centre" },
  { id: "applications", route: "/admin/submissions", heading: "Applications" },
  {
    id: "form-builder",
    route: "/admin/submissions/form",
    heading: "Call for Speakers Form Builder",
  },
  { id: "communications", route: "/admin/communications", heading: "Communications Centre" },
  { id: "event-settings", route: "/admin/event" },
  { id: "branding", route: "/admin/branding" },
  { id: "evaluation", route: "/admin/review" },
  { id: "review-workbench", route: "/review/workbench", role: "evaluator" },
  { id: "speaker-dashboard", route: "/participant/dashboard", role: "speaker" },
  { id: "speaker-profile", route: "/participant/profile", role: "speaker" },
  { id: "event-speakers", route: "/admin/speakers" },
  { id: "speaker-directory", route: "/admin/crm" },
  { id: "speaker-pipeline", route: "/admin/crm/pipeline" },
  { id: "speaker-outreach", route: "/admin/crm/outreach" },
  { id: "programme", route: "/admin/programme" },
  { id: "schedule", route: "/admin/schedule" },
  { id: "tasks", route: "/admin/tasks" },
  { id: "resources", route: "/admin/resources" },
  { id: "public-application", route: "/apply/form" },
  { id: "public-programme", route: "/public/programme/future-of-events-2027" },
];
export const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};
export const visualAspects = {
  overall:
    "Judge the overall visual composition and finish across typography, spacing, alignment, colour, surfaces and component styling.",
  typography:
    "Compare the typographic system: type scale, weight, line height, tracking, title-to-label relationships and optical balance. Prefer coherent, deliberate hierarchy over indiscriminately larger, bolder or smaller text.",
  spacing:
    "Compare spacing rhythm, padding, gaps, alignment, margins and whitespace balance. Prefer consistent relationships and clean shared edges; neither maximum density nor maximum whitespace is a goal by itself.",
  surfaces:
    "Compare colour harmony, canvas/sidebar/panel relationships, borders, separators, radii, shadows and layering. Prefer coherent surface treatment and controlled contrast over decoration or an excess of boxes.",
  components:
    "Compare button, input, select, tab, badge and icon styling where visible. Assess consistent heights, padding, baselines, border/radius treatments, icon scale and stroke weight, and a deliberate visual emphasis ladder.",
};
export const visualMethod = "visual-ui-v3-unanimous";
export function visualCriterion(aspect = "overall") {
  if (!Object.hasOwn(visualAspects, aspect)) throw new Error(`Unknown visual aspect: ${aspect}`);
  return (
    "Which interface has stronger visual/UI design craft at the supplied size? " +
    visualAspects[aspect] +
    " Assess visible styling only. Do not score task completion, workflow efficiency, feature " +
    "count, number of records above the fold, or inferred interaction behavior. Do not prefer " +
    "a brand, exact palette, light/dark theme, or familiar logo by itself. Different products " +
    "may have different content and layouts; compare the quality of the stated visual " +
    "relationships, not missing features or literal resemblance. Explain concrete visual " +
    "differences rather than calling one design modern, premium or polished without evidence."
  );
}
export const absoluteCriterion =
  "Assess only the candidate's visible UI finish at the original screenshot size. Text is " +
  "legible and uses deliberate visual hierarchy. Repeated controls have coherent geometry, " +
  "padding and icon sizing; shared edges and text baselines align. Spacing and surface " +
  "treatments form a coherent visual system. No accidental overlap, clipped labels or " +
  "content collisions are visible. A different brand palette or light/dark theme is valid. " +
  "Do not score workflow efficiency, record visibility, feature coverage or unseen behavior. " +
  "Fail unreadable text even if the composition otherwise appears attractive.";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readCapture(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "capture.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.views) ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.revision ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.methodSha256 ?? "") ||
    typeof manifest.chromium !== "string" ||
    !["normal", "unreadable"].includes(manifest.variant)
  )
    throw new Error("Invalid UX capture manifest");
  const ids = new Set();
  for (const view of manifest.views) {
    if (
      !surfaces.some((surface) => surface.id === view.surface && surface.route === view.route) ||
      !Object.hasOwn(viewports, view.device) ||
      view.viewport?.width !== viewports[view.device].width ||
      view.viewport?.height !== viewports[view.device].height ||
      view.id !== `${view.surface}-${view.device}` ||
      ids.has(view.id) ||
      view.file !== `${view.id}.png` ||
      !Array.isArray(view.failures)
    )
      throw new Error("Invalid or duplicate UX view");
    ids.add(view.id);
    const file = path.join(directory, view.file);
    if (!fs.lstatSync(file).isFile() || sha256(fs.readFileSync(file)) !== view.sha256)
      throw new Error(`UX image integrity failed: ${view.id}`);
  }
  if (ids.size !== surfaces.length * Object.keys(viewports).length)
    throw new Error("Incomplete UX capture; every surface and viewport is required");
  return manifest;
}
