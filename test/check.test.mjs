import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectRoutes, isExcluded, pageFails, parseArgs, parseSitemap, renderMarkdown, toRoute } from "../check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("parseArgs", () => {
  test("defaults", () => {
    const options = parseArgs(["--url", "http://localhost:3000/"]);
    assert.equal(options.url, "http://localhost:3000");
    assert.deepEqual(options.viewports, ["desktop", "phone"]);
    assert.equal(options.failOn, "violation");
    assert.equal(options.tags.includes("wcag22aa"), true);
  });

  test("lists take spaces, commas and newlines", () => {
    const options = parseArgs(["--url", "http://x.test", "--routes", "/ /a\n/b,/c", "--viewports", "phone"]);
    assert.deepEqual(options.routes, ["/", "/a", "/b", "/c"]);
    assert.deepEqual(options.viewports, ["phone"]);
  });

  test("rejects what it does not know", () => {
    assert.throws(() => parseArgs([]), /--url/);
    assert.throws(() => parseArgs(["--url", "http://x.test", "--viewports", "watch"]), /Unknown viewport/);
    assert.throws(() => parseArgs(["--url", "http://x.test", "--fail-on", "sometimes"]), /--fail-on/);
  });
});

describe("routes", () => {
  test("parseSitemap reads plain and CDATA entries", () => {
    const { index, locs } = parseSitemap(
      "<urlset><url><loc>https://a.test/x?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.test/y]]></loc></url></urlset>",
    );
    assert.equal(index, false);
    assert.deepEqual(locs, ["https://a.test/x?a=1&b=2", "https://a.test/y"]);
  });

  test("toRoute keeps path and query, drops the origin", () => {
    assert.equal(toRoute("https://example.com/de/kontakt?x=1"), "/de/kontakt?x=1");
    assert.equal(toRoute("/about"), "/about");
    assert.equal(toRoute("not a url"), null);
  });

  test("isExcluded matches a page or everything below a prefix", () => {
    assert.equal(isExcluded("/blog/post", ["/blog/*"]), true);
    assert.equal(isExcluded("/blog", ["/blog/*"]), false);
    assert.equal(isExcluded("/imprint?x=1", ["/imprint"]), true);
    assert.equal(isExcluded("/imprint/more", ["/imprint"]), false);
  });

  test("collectRoutes follows a sitemap index on the site under test", async () => {
    const files = {
      "http://localhost:3000/sitemap.xml":
        "<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap></sitemapindex>",
      "http://localhost:3000/pages.xml":
        "<urlset><url><loc>https://example.com/b</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/admin/x</loc></url></urlset>",
    };
    const options = { ...parseArgs(["--url", "http://localhost:3000", "--exclude", "/admin/*"]) };
    const { routes, skipped } = await collectRoutes(options, async (source) => files[source]);
    assert.deepEqual(routes, ["/a", "/b"]);
    assert.equal(skipped, 0);
  });

  test("collectRoutes stops at max-pages and says how many it left out", async () => {
    const options = parseArgs(["--url", "http://x.test", "--routes", "/c /a /b", "--max-pages", "2"]);
    assert.deepEqual(await collectRoutes(options), { routes: ["/a", "/b"], skipped: 1 });
  });
});

describe("result", () => {
  const violation = (impact) => ({ id: "x", impact, help: "h", helpUrl: "u", nodes: [{ html: "<a>" }] });

  test("pageFails follows --fail-on", () => {
    const moderate = { violations: [violation("moderate")] };
    assert.equal(pageFails(moderate, "violation"), true);
    assert.equal(pageFails(moderate, "serious"), false);
    assert.equal(pageFails({ violations: [violation("critical")] }, "serious"), true);
    assert.equal(pageFails(moderate, "never"), false);
    assert.equal(pageFails({ violations: [] }, "violation"), false);
    assert.equal(pageFails({ error: "HTTP 500" }, "never"), true);
  });

  test("renderMarkdown groups by rule and lists errors", () => {
    const markdown = renderMarkdown({
      url: "http://x.test",
      engine: { version: "4.14.0" },
      tags: ["wcag2a"],
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
      checked: 3,
      passed: 1,
      skipped: 0,
      pages: [
        { route: "/", viewport: "desktop", violations: [] },
        { route: "/a|b", viewport: "desktop", violations: [violation("serious")] },
        { route: "/gone", viewport: "desktop", error: "HTTP 404" },
      ],
    });
    assert.match(markdown, /1\/3 pages pass/);
    assert.match(markdown, /\| serious \| \[x\]\(u\): h \| `\/a\\\|b` \| 1 \|/);
    assert.match(markdown, /`\/gone` \| desktop \| HTTP 404/);
  });
});

// npm installs the command as a link in node_modules/.bin, and npx starts it from there
describe("started through a link", () => {
  test("runs the check, so a missing --url is an error", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "axe-routes-test-")), "axe-routes");
    symlinkSync(join(HERE, "..", "check.mjs"), link);
    const { code, stderr } = await new Promise((ok) =>
      execFile(process.execPath, [link], { env: { ...process.env, A11Y_BASE_URL: "" } }, (error, stdout, stderr) =>
        ok({ code: error?.code ?? 0, stderr }),
      ),
    );
    assert.equal(code, 2);
    assert.match(stderr, /--url needs the address/);
  });
});

const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(
  (path) => path && existsSync(path),
);

describe("against a real page", { skip: !chrome && "no Chromium" }, () => {
  let server;
  let url;
  before(async () => {
    server = createServer((request, response) => {
      const file = join(HERE, "site", request.url === "/" ? "index.html" : request.url.split("?")[0]);
      if (!existsSync(file)) return response.writeHead(404).end("Not found");
      response.writeHead(200, { "Content-Type": file.endsWith(".xml") ? "application/xml" : "text/html" });
      response.end(readFileSync(file));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const check = (...args) =>
    new Promise((ok) => {
      const json = join(mkdtempSync(join(tmpdir(), "axe-routes-test-")), "report.json");
      execFile(
        process.execPath,
        [join(HERE, "..", "check.mjs"), "--url", url, "--viewports", "desktop", "--wait", "0", "--json", json, ...args],
        { env: { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "" } },
        (error, stdout, stderr) =>
          ok({ code: error?.code ?? 0, stdout, stderr, report: existsSync(json) ? JSON.parse(readFileSync(json)) : null }),
      );
    });

  test("a clean page passes", async () => {
    const { code, report } = await check("--routes", "/");
    assert.equal(code, 0);
    assert.equal(report.passed, 1);
  });

  test("the sitemap drives the check: violations and an error page fail", async () => {
    const { code, report } = await check();
    assert.equal(code, 1);
    assert.deepEqual(report.pages.map((p) => p.route), ["/", "/broken.html", "/missing.html"]);
    assert.equal(report.passed, 1);
    const rules = report.pages[1].violations.map((v) => v.id);
    assert.deepEqual(rules.sort(), ["button-name", "color-contrast", "image-alt"]);
    assert.equal(report.pages[2].error, "HTTP 404");
  });

  test("--fail-on never still fails on an error page, but not on violations", async () => {
    assert.equal((await check("--routes", "/broken.html", "--fail-on", "never")).code, 0);
    assert.equal((await check("--routes", "/missing.html", "--fail-on", "never")).code, 1);
  });

  test("a site that is not there is an error, not a result", async () => {
    const { code, stderr } = await check("--url", "http://127.0.0.1:9", "--sitemap", "http://127.0.0.1:9/sitemap.xml");
    assert.equal(code, 2);
    assert.notEqual(stderr, "");
  });
});
