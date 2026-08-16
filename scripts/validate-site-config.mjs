/*
 * Public website release gate.
 *
 * programcue.com is what Google's OAuth reviewers read before they will let the
 * production client out of testing, so the requirements it has to meet are
 * external and unforgiving: three public URLs answering 200, a real contact
 * address, no placeholder text, no noindex, no broken links, and a privacy
 * policy that states the Google scopes and the Limited Use commitment. Those
 * are easy to break with an innocent edit and expensive to discover from a
 * rejected verification, so they are asserted here rather than trusted.
 *
 * This also asserts the site Worker holds no binding to production data. It
 * serves static files and nothing else.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

import { repositoryRoot } from "./e2e-runtime.mjs";

const SITE_CONFIG_FILE = "./site/wrangler.jsonc";
const ASSET_ROOT = join(repositoryRoot, "site/public");

const CONTACT_EMAIL = "support@programcue.com";
const SIGN_IN_URL = "https://app.programcue.com/sign-in";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
const LIMITED_USE_STATEMENT =
  "The use of information received from Google Workspace APIs will adhere to the Google User Data Policy, including the Limited Use requirements.";
/* OAuth reviewers need an accurate public description of the product, not one
   permanently frozen marketing sentence. Keep the visible homepage honest
   about the connected workflow and its material stages while allowing the
   headline and supporting copy to improve. */
const CONNECTED_WORKFLOW_TERMINOLOGY = /\bconnect(?:ed|s|ing)?\b/i;
const REQUIRED_PRODUCT_CAPABILITIES = Object.freeze([
  ["submissions", /\bsubmissions?\b/i],
  ["reviews", /\breviews?\b/i],
  ["speakers", /\bspeakers?\b/i],
  ["communications", /\bcommunications?\b/i],
  ["scheduling", /\bschedul(?:e|es|ed|ing)\b/i],
  ["publication", /\bpublish(?:ed|es|ing)?\b|\bpublication\b/i],
]);
const CONNECTED_WORKFLOW_MINIMUM_STAGES = 3;
const REQUIRED_PRODUCT_TERMINOLOGY = /\bcall(?:\s+|-)for(?:\s+|-)speakers\b/i;
const REJECTED_PRODUCT_TERMINOLOGY = /\bcalls?(?:\s+|-)for(?:\s+|-)papers\b/i;
const ACCOUNT_ACTION = "Sign in or create an account";
const SOCIAL_CARD = "social-card.png";
const BRAND_MARK = "brand-mark.svg";
const OFFICIAL_BRAND_PATHS = Object.freeze([
  "M3 3h10v4H7v6H3V3Z",
  "M19 3h10v10h-4V7h-6V3Z",
  "M25 19h4v10H19v-4h6v-6Z",
  "M3 19h4v6h6v4H3V19Z",
]);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/* Every page a visitor or a reviewer can reach, and the footer contract each
   one owes the other two. */
export const PUBLISHED_PAGES = Object.freeze([
  { path: "/", file: "index.html" },
  { path: "/privacy", file: "privacy.html" },
  { path: "/terms", file: "terms.html" },
]);
const FOOTER_LINKS = Object.freeze(["/", "/privacy", "/terms"]);

/* Text that means "not finished". `draft` is absent deliberately: the terms
   legitimately discuss message drafts, and \b would not save us there. */
const PLACEHOLDER_MARKERS = Object.freeze([
  "todo",
  "tbd",
  "fixme",
  "lorem ipsum",
  "placeholder",
  "coming soon",
  "[insert",
  "your company",
  "example.com",
  "{{",
]);

const DATA_BINDINGS = Object.freeze([
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "queues",
  "durable_objects",
  "workflows",
  "ai",
  "triggers",
]);

export function readSiteConfig() {
  return unstable_readConfig(
    { config: SITE_CONFIG_FILE },
    { hideWarnings: true },
  );
}

function sameMembers(actual = [], expected = []) {
  return (
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

export function validateSiteConfig(config) {
  const issues = [];
  const add = (message) => issues.push(message);

  if (config.name !== "program-cue-site")
    add("Site Worker name must be program-cue-site.");
  if (!config.main?.endsWith("/site/src/index.ts"))
    add("Site Worker main must be site/src/index.ts.");
  if (config.compatibility_date !== "2026-08-08")
    add("Site compatibility date must be 2026-08-08.");
  if ((config.compatibility_flags ?? []).length)
    add("Static site Worker needs no compatibility flags.");
  if (config.workers_dev !== false)
    add("Site workers.dev access must be disabled.");

  const patterns = (config.routes ?? []).map((route) => route.pattern);
  if (
    !sameMembers(patterns, ["programcue.com", "www.programcue.com"]) ||
    !(config.routes ?? []).every((route) => route.custom_domain === true)
  ) {
    add(
      "Site must serve programcue.com and www.programcue.com as Custom Domains.",
    );
  }

  const assets = config.assets ?? {};
  if (assets.binding !== "ASSETS")
    add("Site assets binding must be named ASSETS.");
  /* Wrangler resolves `main` to an absolute path but leaves `assets.directory`
     relative to the config file, so this compares the literal value. */
  if (assets.directory !== "./public")
    add(
      "Site assets directory must be ./public, relative to site/wrangler.jsonc.",
    );
  if (assets.html_handling !== "auto-trailing-slash")
    add(
      "Site html_handling must be auto-trailing-slash so /privacy and /terms answer 200 without redirecting.",
    );
  if (assets.not_found_handling !== "404-page")
    add("Site not_found_handling must serve the 404 page.");
  if (assets.run_worker_first !== true)
    add(
      "Site must run the Worker first so the canonical redirect and security headers apply to HTML.",
    );

  if (Object.keys(config.vars ?? {}).length)
    add("Static site Worker must declare no vars.");
  for (const binding of DATA_BINDINGS) {
    const value = config[binding];
    const present = Array.isArray(value)
      ? value.length > 0
      : binding === "durable_objects"
        ? (value?.bindings ?? []).length > 0
        : binding === "queues"
          ? (value?.producers ?? []).length > 0 ||
            (value?.consumers ?? []).length > 0
          : binding === "triggers"
            ? (value?.crons ?? []).length > 0
            : Boolean(value);
    if (present)
      add(`Site Worker must not bind ${binding}; it serves static files only.`);
  }

  if (
    config.observability?.enabled !== true ||
    config.observability?.logs?.enabled !== true ||
    config.observability?.logs?.invocation_logs !== true
  ) {
    add("Site must enable observability with invocation logs.");
  }
  if (config.upload_source_maps !== true)
    add("Site source-map upload must be enabled.");

  return issues;
}

/* Tag-stripped text, so an assertion survives the line wrapping and inline
   links that a formatter introduces into a sentence. */
export function documentText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* Mirrors the asset router's auto-trailing-slash resolution, so a link this
   accepts is a link the deployed Worker can actually serve. */
function assetForPath(assetRoot, pathname) {
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return "index.html";
  for (const candidate of [`${clean}.html`, `${clean}/index.html`, clean]) {
    if (existsSync(join(assetRoot, candidate))) return candidate;
  }
  return undefined;
}

function hasAnchor(html, fragment) {
  return new RegExp(`\\sid="${fragment}"`).test(html);
}

function footerOf(html) {
  return /<footer[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? "";
}

export function validateSitePages(assetRoot = ASSET_ROOT) {
  const issues = [];
  const add = (message) => issues.push(message);

  const required = [...PUBLISHED_PAGES.map((page) => page.file), "404.html"];
  const missing = required.filter((file) => !existsSync(join(assetRoot, file)));
  if (missing.length) {
    add(`Missing published pages: ${missing.join(", ")}.`);
    return issues;
  }

  const readAsset = (file) => readFileSync(join(assetRoot, file), "utf8");
  const sources = new Map(
    [...required, "robots.txt", "sitemap.xml"].map((file) => [
      file,
      existsSync(join(assetRoot, file)) ? readAsset(file) : "",
    ]),
  );

  const brandMarkPath = join(assetRoot, BRAND_MARK);
  if (!existsSync(brandMarkPath))
    add(`Public site brand mark ${BRAND_MARK} is missing.`);
  else if (
    !readFileSync(brandMarkPath).equals(
      readFileSync(join(repositoryRoot, "public", BRAND_MARK)),
    )
  ) {
    add("Public site brand mark must match the canonical application asset.");
  }

  for (const file of required) {
    const html = sources.get(file);
    const text = documentText(html).toLowerCase();

    for (const marker of PLACEHOLDER_MARKERS) {
      if (text.includes(marker))
        add(`${file} contains placeholder text: "${marker}".`);
    }
    if (REJECTED_PRODUCT_TERMINOLOGY.test(html))
      add(`${file} must not use "call for papers" terminology.`);
    if (/content="[^"]*no(index|follow)/i.test(html))
      add(`${file} must not carry a noindex or nofollow robots directive.`);
    if (!/<html lang="/.test(html))
      add(`${file} must declare a page language.`);
    if (!/name="viewport"/.test(html))
      add(`${file} must declare a viewport so it works on mobile.`);
    if (/\sstyle=/i.test(html))
      add(`${file} must not use inline styles; the site CSP blocks them.`);
    if (/<script\b/i.test(html))
      add(
        `${file} must not include scripts; the public site is deliberately static.`,
      );
    if (/\son[a-z]+\s*=/i.test(html))
      add(`${file} must not include inline event handlers.`);
    if (!html.includes(CONTACT_EMAIL))
      add(`${file} must publish the monitored contact address.`);
    if (!html.includes(`rel="icon" href="/${BRAND_MARK}"`))
      add(`${file} must use the official Program Cue mark as its favicon.`);
    if (!html.includes('class="wordmark-mark"'))
      add(`${file} must render the official Program Cue wordmark.`);
    for (const path of OFFICIAL_BRAND_PATHS) {
      if (html.split(`d="${path}"`).length - 1 < 2)
        add(`${file} wordmark is missing official mark geometry: ${path}.`);
    }

    const footer = footerOf(html);
    if (!footer) add(`${file} must have a footer.`);
    for (const link of FOOTER_LINKS) {
      if (!footer.includes(`href="${link}"`))
        add(`${file} footer must link to ${link}.`);
    }
    if (!footer.includes(`mailto:${CONTACT_EMAIL}`))
      add(`${file} footer must show the monitored contact address.`);
  }

  for (const page of PUBLISHED_PAGES) {
    const html = sources.get(page.file);
    if (
      !html.includes(
        `rel="canonical" href="https://programcue.com${page.path}"`,
      )
    )
      add(
        `${page.file} must declare its canonical https://programcue.com URL.`,
      );
  }

  /* --- homepage ---------------------------------------------------------- */
  const home = sources.get("index.html");
  const homeMarkup = home.replace(/\s+/g, " ");
  const homeText = documentText(home);
  if (!REQUIRED_PRODUCT_TERMINOLOGY.test(home))
    add('Home page must use "call for speakers" terminology.');
  /* Keep this claim scoped to a single piece of product copy. A page-wide
     search can be satisfied by the unrelated Google Calendar disclosure. */
  const visibleCopyBlocks = Array.from(
    home.matchAll(/<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi),
    ([markup]) => documentText(markup),
  );
  const hasConnectedWorkflowClaim = visibleCopyBlocks.some(
    (copy) =>
      CONNECTED_WORKFLOW_TERMINOLOGY.test(copy) &&
      REQUIRED_PRODUCT_CAPABILITIES.filter(([, pattern]) => pattern.test(copy))
        .length >= CONNECTED_WORKFLOW_MINIMUM_STAGES,
  );
  if (!hasConnectedWorkflowClaim)
    add("Home page must describe Program Cue as a connected workflow.");
  const missingCapabilities = REQUIRED_PRODUCT_CAPABILITIES.filter(
    ([, pattern]) => !pattern.test(homeText),
  ).map(([label]) => label);
  if (missingCapabilities.length) {
    add(
      `Home page must describe the essential product capabilities: ${missingCapabilities.join(", ")}.`,
    );
  }
  if (!home.includes(`href="${SIGN_IN_URL}"`))
    add(`Home page must link to ${SIGN_IN_URL}.`);
  if (!homeText.includes(ACCOUNT_ACTION))
    add(`Home page must offer a "${ACCOUNT_ACTION}" action.`);
  const socialCardPath = join(assetRoot, SOCIAL_CARD);
  if (!existsSync(socialCardPath))
    add(`Home page social sharing image ${SOCIAL_CARD} is missing.`);
  else {
    const image = readFileSync(socialCardPath);
    const validPng =
      image.length >= 24 &&
      image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    if (
      !validPng ||
      image.readUInt32BE(16) !== 1200 ||
      image.readUInt32BE(20) !== 630
    ) {
      add(`Home page social sharing image must be a 1200 by 630 PNG.`);
    }
  }
  for (const socialMetadata of [
    `property="og:image" content="https://programcue.com/${SOCIAL_CARD}"`,
    'property="og:image:type" content="image/png"',
    'property="og:image:alt" content="Program Cue conference programme workflow preview"',
    'name="twitter:card" content="summary_large_image"',
    `name="twitter:image" content="https://programcue.com/${SOCIAL_CARD}"`,
    'name="twitter:image:alt" content="Program Cue conference programme workflow preview"',
  ]) {
    if (!homeMarkup.includes(socialMetadata))
      add(`Home page must publish social metadata: ${socialMetadata}.`);
  }
  if (
    !homeText.includes(
      "Creating a Program Cue account does not automatically grant access to an organisation or event",
    )
  ) {
    add("Home page must state that an account alone grants no event access.");
  }
  if (!homeText.includes("invitation or access assignment"))
    add(
      "Home page must state that private roles and workspaces need an invitation or access assignment.",
    );
  if (
    !homeText.includes(
      "Google Sign-In can be used to create or access a Program Cue account.",
    ) ||
    !homeText.includes(
      "Users may also optionally connect Google Calendar so Program Cue can create, update, cancel and reconcile session invitations managed through Program Cue.",
    )
  ) {
    add("Home page must carry the approved Google integration explanation.");
  }
  for (const outcome of [
    "Move from proposal to decision",
    "Act on readiness, not guesswork",
    "Publish from a checked schedule",
  ]) {
    if (!new RegExp(`<h3>${outcome}</h3>`).test(home))
      add(`Home page must explain the outcome: ${outcome}.`);
  }

  /* --- privacy policy ---------------------------------------------------- */
  const privacy = sources.get("privacy.html");
  const privacyText = documentText(privacy);
  if (!privacyText.includes(LIMITED_USE_STATEMENT))
    add("Privacy policy must carry the Google Limited Use statement verbatim.");
  if (!hasAnchor(privacy, "google-user-data"))
    add("Privacy policy must expose a #google-user-data section anchor.");
  if (!privacyText.includes(CALENDAR_SCOPE))
    add(`Privacy policy must name the ${CALENDAR_SCOPE} scope.`);
  if (
    !/openid/.test(privacyText) ||
    !/\bemail\b/.test(privacyText) ||
    !/\bprofile\b/.test(privacyText)
  ) {
    add(
      "Privacy policy must name the openid, email and profile sign-in scopes.",
    );
  }
  for (const phrase of [
    "create, update, cancel and reconcile",
    "primary calendar",
    "does not provide general calendar browsing",
    "advertising",
    "encrypted at rest",
    "Google Account",
  ]) {
    if (!privacyText.includes(phrase))
      add(`Privacy policy must state: "${phrase}".`);
  }
  for (const provider of ["Cloudflare", "Google", "Microsoft", "Resend"]) {
    if (!privacyText.includes(provider))
      add(`Privacy policy must disclose the ${provider} provider.`);
  }
  if (!/Effective date: \d{1,2} \w+ \d{4}/.test(privacyText))
    add("Privacy policy must carry an effective date.");
  if (
    !privacyText.includes(
      "Program Cue is responsible for the personal information",
    )
  )
    add(
      "Privacy policy must identify Program Cue as the responsible operator.",
    );
  for (const unsupportedBackupClaim of [
    "periodically verify that they can be restored",
    "Backups are retained on a rolling schedule",
  ]) {
    if (privacyText.includes(unsupportedBackupClaim))
      add(
        `Privacy policy must not claim unverified production backup assurance: "${unsupportedBackupClaim}".`,
      );
  }
  for (const sessionizeBoundary of [
    "read one public Sessionize speaker profile",
    "does not sign in to Sessionize",
    "access private Sessionize data",
    "ongoing organisation connection",
  ]) {
    if (!privacyText.includes(sessionizeBoundary))
      add(
        `Privacy policy must state the Sessionize boundary: "${sessionizeBoundary}".`,
      );
  }

  /* --- terms ------------------------------------------------------------- */
  const terms = sources.get("terms.html");
  const termsText = documentText(terms);
  if (!/Effective date: \d{1,2} \w+ \d{4}/.test(termsText))
    add("Terms must carry an effective date.");
  if (!termsText.includes("Program Cue is based in Victoria, Australia"))
    add("Terms must identify Program Cue and its location.");
  if (!termsText.includes("laws of Victoria, Australia"))
    add("Terms must state the governing law.");
  if (
    !termsText.includes(
      "Signing up for an account does not by itself grant access to any private workspace, organisation, event or role.",
    )
  ) {
    add("Terms must state that signing up grants no private access.");
  }
  for (const sessionizeBoundary of [
    "read one public Sessionize speaker profile",
    "This is not a Sessionize login, credentialed integration, private-data import or ongoing organisation connection.",
  ]) {
    if (!termsText.includes(sessionizeBoundary))
      add(`Terms must state the Sessionize boundary: "${sessionizeBoundary}".`);
  }
  if (/Accelevents, Airtable and Sessionize/.test(termsText))
    add(
      "Terms must not describe Sessionize as a credentialed organisation integration.",
    );

  /* --- crawlability ------------------------------------------------------ */
  const robots = sources.get("robots.txt");
  if (/^\s*Disallow:\s*\S/im.test(robots))
    add("robots.txt must not disallow any path.");
  if (!robots.includes("Sitemap: https://programcue.com/sitemap.xml"))
    add("robots.txt must advertise the sitemap.");
  const sitemap = sources.get("sitemap.xml");
  for (const page of PUBLISHED_PAGES) {
    if (!sitemap.includes(`<loc>https://programcue.com${page.path}</loc>`))
      add(`sitemap.xml must list https://programcue.com${page.path}.`);
  }

  /* --- link integrity ---------------------------------------------------- */
  for (const file of required) {
    const html = sources.get(file);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (href.startsWith("mailto:")) {
        if (href !== `mailto:${CONTACT_EMAIL}`)
          add(`${file} links to an unexpected mailbox: ${href}.`);
        continue;
      }
      if (/^https?:/.test(href)) {
        if (!href.startsWith("https://"))
          add(`${file} links over plain HTTP: ${href}.`);
        continue;
      }
      const [pathname, fragment] = href.split("#");
      if (pathname && !pathname.startsWith("/")) {
        add(`${file} uses a relative link that may break: ${href}.`);
        continue;
      }
      const target = pathname
        ? assetForPath(assetRoot, pathname)
        : /* same-page anchor */ file;
      if (!target) {
        add(`${file} links to a missing page: ${href}.`);
        continue;
      }
      if (
        fragment &&
        !hasAnchor(sources.get(target) ?? readAsset(target), fragment)
      ) {
        add(`${file} links to a missing anchor: ${href}.`);
      }
    }
    for (const [, src] of html.matchAll(/\ssrc="([^"]+)"/g)) {
      if (/^https:/.test(src)) continue;
      if (!src.startsWith("/")) {
        add(`${file} uses a relative asset path that may break: ${src}.`);
        continue;
      }
      if (!assetForPath(assetRoot, src))
        add(`${file} references a missing asset: ${src}.`);
    }
  }

  return issues;
}

function run() {
  const issues = [
    ...validateSiteConfig(readSiteConfig()),
    ...validateSitePages(),
  ];
  if (issues.length) {
    console.error(
      `Public website is not release-ready:\n- ${issues.join("\n- ")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("Public website passed fail-fast validation.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run();
