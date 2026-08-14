import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { repositoryRoot } from "./e2e-runtime.mjs";
import {
  documentText,
  readSiteConfig,
  validateSiteConfig,
  validateSitePages,
} from "./validate-site-config.mjs";

const SOURCE_ASSETS = join(repositoryRoot, "site/public");
const temporaryRoots = [];

/* A throwaway copy of the published site, mutated to prove the gate reacts. */
function brokenSite(mutate) {
  const root = mkdtempSync(join(tmpdir(), "program-cue-site-"));
  temporaryRoots.push(root);
  cpSync(SOURCE_ASSETS, root, { recursive: true });
  mutate({
    read: (file) => readFileSync(join(root, file), "utf8"),
    remove: (file) => rmSync(join(root, file)),
    write: (file, contents) => writeFileSync(join(root, file), contents),
    replace: (file, from, to) =>
      writeFileSync(
        join(root, file),
        readFileSync(join(root, file), "utf8").replace(from, to),
      ),
  });
  return validateSitePages(root);
}

function reports(issues, fragment) {
  return issues.some((issue) => issue.includes(fragment));
}

after(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

describe("site Worker configuration", () => {
  const config = readSiteConfig();

  test("the checked-in configuration is release-ready", () => {
    assert.deepEqual(validateSiteConfig(config), []);
  });

  test("both public hostnames are served as Custom Domains", () => {
    assert.deepEqual(config.routes.map((route) => route.pattern).sort(), [
      "programcue.com",
      "www.programcue.com",
    ]);
    assert.ok(config.routes.every((route) => route.custom_domain === true));
  });

  test("a workers.dev fallback is rejected", () => {
    const issues = validateSiteConfig({ ...config, workers_dev: true });
    assert.ok(reports(issues, "workers.dev"));
  });

  test("losing a public hostname is rejected", () => {
    const issues = validateSiteConfig({
      ...config,
      routes: [{ pattern: "programcue.com", custom_domain: true }],
    });
    assert.ok(reports(issues, "www.programcue.com"));
  });

  test("serving assets ahead of the Worker is rejected", () => {
    const issues = validateSiteConfig({
      ...config,
      assets: { ...config.assets, run_worker_first: false },
    });
    assert.ok(reports(issues, "run the Worker first"));
  });

  test("html_handling that would redirect /privacy is rejected", () => {
    const issues = validateSiteConfig({
      ...config,
      assets: { ...config.assets, html_handling: "force-trailing-slash" },
    });
    assert.ok(reports(issues, "auto-trailing-slash"));
  });

  test("binding production data to the public site is rejected", () => {
    const issues = validateSiteConfig({
      ...config,
      d1_databases: [{ binding: "DB", database_name: "program-cue-db" }],
    });
    assert.ok(reports(issues, "must not bind d1_databases"));
  });
});

describe("published pages", () => {
  test("the checked-in site is release-ready", () => {
    assert.deepEqual(validateSitePages(), []);
  });

  test("a footer that drops a sibling page is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "index.html",
        '<li><a href="/terms">Terms of service</a></li>',
        "",
      ),
    );
    assert.ok(reports(issues, "index.html footer must link to /terms"));
  });

  test("a noindex directive is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "privacy.html",
        '<meta name="robots" content="index, follow" />',
        '<meta name="robots" content="noindex" />',
      ),
    );
    assert.ok(reports(issues, "noindex"));
  });

  test("inline styles blocked by the site CSP are rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "index.html",
        '<main id="main">',
        '<main id="main" style="color: red">',
      ),
    );
    assert.ok(reports(issues, "must not use inline styles"));
  });

  test("scripts and inline event handlers are rejected", () => {
    const scriptIssues = brokenSite(({ replace }) =>
      replace(
        "index.html",
        "</body>",
        '<script src="/site.js"></script></body>',
      ),
    );
    const handlerIssues = brokenSite(({ replace }) =>
      replace(
        "index.html",
        '<main id="main">',
        '<main id="main" onclick="go()">',
      ),
    );
    assert.ok(reports(scriptIssues, "must not include scripts"));
    assert.ok(reports(handlerIssues, "inline event handlers"));
  });

  test("losing the Google Limited Use statement is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace("privacy.html", "including the Limited Use requirements.", "."),
    );
    assert.ok(reports(issues, "Limited Use statement"));
  });

  test("losing the Calendar scope is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "privacy.html",
        "https://www.googleapis.com/auth/calendar.events.owned",
        "calendar scope removed",
      ),
    );
    assert.ok(reports(issues, "calendar.events.owned"));
  });

  test("unverified production backup assurance is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "privacy.html",
        "A production export has been restored",
        "We keep backups of the database and periodically verify that they can be restored. A production export has been restored",
      ),
    );
    assert.ok(reports(issues, "unverified production backup assurance"));
  });

  test("describing Sessionize as a credentialed organisation integration is rejected", () => {
    const privacyIssues = brokenSite(({ read, write }) =>
      write(
        "privacy.html",
        read("privacy.html").replaceAll("Sessionize", "Other provider"),
      ),
    );
    const termsIssues = brokenSite(({ replace }) =>
      replace(
        "terms.html",
        "Accelevents or Airtable",
        "Accelevents, Airtable and Sessionize",
      ),
    );
    assert.ok(reports(privacyIssues, "Sessionize boundary"));
    assert.ok(reports(termsIssues, "credentialed organisation integration"));
  });

  test("a link to a page that does not exist is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace("index.html", 'href="/privacy"', 'href="/pricing"'),
    );
    assert.ok(reports(issues, "links to a missing page: /pricing"));
  });

  test("a link to an anchor that does not exist is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "index.html",
        'href="/privacy#google-user-data"',
        'href="/privacy#google-data"',
      ),
    );
    assert.ok(reports(issues, "missing anchor: /privacy#google-data"));
  });

  test("placeholder copy is rejected", () => {
    const issues = brokenSite(({ replace }) =>
      replace(
        "terms.html",
        '<h2 id="fees">9. Fees</h2>',
        "<h2>TODO: fees</h2>",
      ),
    );
    assert.ok(reports(issues, "placeholder text"));
  });

  test("call-for-speakers terminology is required", () => {
    const missingIssues = brokenSite(({ read, write }) =>
      write(
        "index.html",
        read("index.html").replaceAll(/call for speakers/gi, "proposal intake"),
      ),
    );
    assert.ok(reports(missingIssues, 'must use "call for speakers"'));

    const hyphenatedIssues = brokenSite(({ read, write }) =>
      write(
        "index.html",
        read("index.html").replaceAll(
          /call for speakers/gi,
          "call-for-speakers",
        ),
      ),
    );
    assert.ok(!reports(hyphenatedIssues, 'must use "call for speakers"'));
  });

  test("call-for-papers variants are rejected throughout the site", () => {
    for (const rejected of [
      "call for papers",
      "calls for papers",
      "call\n for\n papers",
      "call-for-papers",
      "calls-for-papers",
    ]) {
      const issues = brokenSite(({ read, write }) =>
        write(
          "terms.html",
          read("terms.html").replace("</main>", `<p>${rejected}</p></main>`),
        ),
      );
      assert.ok(reports(issues, 'terms.html must not use "call for papers"'));
    }
  });

  test("blocking crawlers in robots.txt is rejected", () => {
    const issues = brokenSite(({ write }) =>
      write("robots.txt", "User-agent: *\nDisallow: /\n"),
    );
    assert.ok(reports(issues, "must not disallow"));
  });

  test("dropping the sign-in action is rejected", () => {
    const issues = brokenSite(({ read, write }) =>
      write(
        "index.html",
        read("index.html").replaceAll("Sign in or create an account", "Log in"),
      ),
    );
    assert.ok(reports(issues, "Sign in or create an account"));
  });

  test("losing the social sharing image is rejected", () => {
    const issues = brokenSite(({ remove }) => remove("social-card.png"));
    assert.ok(reports(issues, "social sharing image"));
  });

  test("a malformed social sharing image is rejected", () => {
    const issues = brokenSite(({ write }) =>
      write("social-card.png", Buffer.alloc(24)),
    );
    assert.ok(reports(issues, "1200 by 630 PNG"));
  });

  test("a non-canonical brand mark is rejected", () => {
    const assetIssues = brokenSite(({ write }) =>
      write("brand-mark.svg", '<svg viewBox="0 0 32 32"><text>P</text></svg>'),
    );
    const wordmarkIssues = brokenSite(({ read, write }) =>
      write(
        "index.html",
        read("index.html").replaceAll(
          "M3 3h10v4H7v6H3V3Z",
          "M3 3h8v4H7v6H3V3Z",
        ),
      ),
    );
    assert.ok(reports(assetIssues, "canonical application asset"));
    assert.ok(reports(wordmarkIssues, "official mark geometry"));
  });

  test("removing the contact address is rejected", () => {
    const issues = brokenSite(({ read, write }) =>
      write(
        "terms.html",
        read("terms.html").replaceAll("support@programcue.com", ""),
      ),
    );
    assert.ok(reports(issues, "monitored contact address"));
  });
});

describe("documentText", () => {
  test("reads a sentence that formatting split across tags and lines", () => {
    const html = `<p>\n  adhere to the\n  <a href="#x">Google User Data\n  Policy</a>, including\n  the Limited Use requirements.\n</p>`;
    assert.equal(
      documentText(html),
      "adhere to the Google User Data Policy, including the Limited Use requirements.",
    );
  });

  test("drops script and style content rather than reading it as copy", () => {
    assert.equal(
      documentText("<style>a{color:red}</style><p>Real</p>"),
      "Real",
    );
  });
});
