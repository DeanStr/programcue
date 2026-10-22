export const saasMethod = "saas-craft-v1";
export const references = [
  {
    id: "linear-sidebar",
    product: "Linear",
    page: "https://linear.app/now/behind-the-latest-design-refresh",
    asset:
      "https://webassets.linear.app/images/ornj730p/production/b6d6be14c96978b10553cfb9205be1065087e793-3904x2720.png",
    sha256: "e8455151bee6433e6add7fd3407d09319612eb900fc02bc35d8bb0960b21e782",
    note: "Published 12 March 2026. Only the updated right-hand navigation is compared; editorial labels, old design and fade are excluded.",
  },
  {
    id: "attio",
    product: "Attio",
    page: "https://attio.com/help/reference/attio-101/attios-data-model/understanding-lists",
    asset: "https://a.storyblok.com/f/234930/2458x1464/5353aa7243/recruiting-list.png",
    sha256: "e91fe259ddb038ffc92ce06e943546dd799a3c5c76b7f2394d2bd109bbbfd8ec",
    note: "Screenshot served by the official help page on 21 October 2026, containing 2025 example dates. The 2458px asset is a high-resolution export, normalized to approximately 1229 CSS pixels. Its live capture date is unverified.",
  },
  {
    id: "notion-forms",
    product: "Notion Forms",
    page: "https://www.notion.com/help/guides/use-forms-to-collect-organize-and-act-on-responses-in-notion",
    asset:
      "https://images.ctfassets.net/spoqsaf9291f/6kEAhrMgwOxaGMUdi6ukvq/dfe3ea388a11063883469bf4ad3e0f68/Screenshot_2024-10-17_at_9.51.42_AM.png",
    sha256: "427ad3fdf7004972899df24112285006dbb79d67f7dbcbbfc4c0faaa92fa7637",
    note: "2024 screenshot still served by the official guide on 21 October 2026. Compared as a form-canvas reference, excluding window chrome. This is not a verified capture of the latest live product.",
  },
  {
    id: "notion-calendar",
    product: "Notion Calendar",
    page: "https://www.notion.com/help/guides/getting-started-with-notion-calendar",
    asset:
      "https://images.ctfassets.net/spoqsaf9291f/idcxytEzq95oo2Y7IqHPm/dcf94ab3ce0a8c17dfed15784a25c192/calendar_screenshot__1_.png",
    sha256: "d354c6027adef69eb01f635339b71784493b11167b2d0b297ab24a18bb88dd1c",
    note: "January 2024 example still served by the official guide on 21 October 2026. Native 960×600 pixels. Compare calendar component craft, excluding feature counts and number of events.",
  },
];

export const benchmarks = [
  {
    id: "NAVIGATION",
    view: "command-desktop",
    reference: "linear-sidebar",
    title: "Navigation typography and icons",
    focus:
      "Navigation type weights, icon scale and stroke consistency, label/icon alignment, active/inactive emphasis and spacing rhythm.",
    referenceCrop: { x: 1515 / 3904, y: 500 / 2720, width: 860 / 3904, height: 600 / 2720 },
    candidateCrop: { x: 0, y: 0, width: 224 / 1440, height: 225 / 1000 },
    panel: { width: 224, height: 225 },
  },
  {
    id: "APPLICATIONS",
    view: "applications-desktop",
    reference: "attio",
    title: "Application table and view controls",
    focus:
      "The visual hierarchy of view controls, filter labels, table headers, primary record text and secondary metadata; control geometry, column alignment and separator restraint.",
    referenceCrop: { x: 0, y: 0, width: 1, height: 800 / 1464 },
    candidateCrop: { x: 254 / 1440, y: 247 / 1000, width: 1162 / 1440, height: 400 / 1000 },
    panel: { width: 1229, height: 430 },
  },
  {
    id: "DIRECTORY",
    view: "speaker-directory-desktop",
    reference: "attio",
    title: "Contact directory rows and filters",
    focus:
      "Contact table typography, primary/secondary row hierarchy, filter/control alignment, spacing rhythm, borders and surface treatment.",
    referenceCrop: { x: 0, y: 0, width: 1, height: 800 / 1464 },
    candidateCrop: { x: 254 / 1440, y: 320 / 1000, width: 1162 / 1440, height: 400 / 1000 },
    panel: { width: 1229, height: 430 },
  },
  {
    id: "FORM",
    view: "form-builder-desktop",
    reference: "notion-forms",
    title: "Form canvas typography and field styling",
    focus:
      "Form canvas title/section/field/helper typography, spacing rhythm, label/input alignment, selection emphasis and restrained borders. Different editor tools and form fields are valid.",
    referenceCrop: { x: 300 / 1920, y: 420 / 1200, width: 1320 / 1920, height: 760 / 1200 },
    candidateCrop: { x: 500 / 1440, y: 288 / 1000, width: 560 / 1440, height: 560 / 1000 },
    panel: { width: 700, height: 600 },
  },
  {
    id: "CALENDAR",
    view: "schedule-desktop",
    reference: "notion-calendar",
    title: "Schedule canvas and event cards",
    focus:
      "Calendar control hierarchy, grid-line restraint, time-label typography, event-card type and padding, colour relationships and alignment. Different room/day layouts and event quantities are valid.",
    referenceCrop: { x: 208 / 960, y: 0, width: 496 / 960, height: 1 },
    candidateCrop: { x: 498 / 1440, y: 260 / 1000, width: 522 / 1440, height: 685 / 1000 },
    panel: { width: 600, height: 720 },
  },
];

export function benchmarkCriterion(benchmark) {
  return `Which image has stronger visual/UI design craft for these comparable elements: ${benchmark.focus} Assess only visible visual relationships. Do not reward a familiar brand, exact palette, light/dark theme, literal resemblance, greater feature count, more records above the fold, or inferred workflow efficiency. These are different products with different content and layouts. Ignore letterboxing and material outside the selected crops. Prefer coherent hierarchy and deliberate finish over indiscriminately smaller, larger, bolder or denser text. Explain concrete visual differences and abstain if the crops cannot support a fair comparison.`;
}
