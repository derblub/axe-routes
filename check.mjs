#!/usr/bin/env node
/**
 * Accessibility check of every route of a site with axe-core in headless Chromium.
 *
 *   node check.mjs --url http://localhost:3000
 *   node check.mjs --url https://example.com --routes "/ /about /contact"
 *   node check.mjs --url http://localhost:3000 --sitemap dist/sitemap.xml --json report.json
 *
 * Routes come from --routes (paths separated by whitespace), or from a sitemap: --sitemap
 * takes a URL or a file, the default is <url>/sitemap.xml. Sitemap indexes are followed.
 * Only the path of each sitemap entry is used, so the sitemap of the production site also
 * drives a check of localhost or a preview deployment.
 *
 * Each route is checked at each viewport (--viewports, default "desktop phone") with the
 * rules of the given axe tags (--tags, default WCAG 2.0, 2.1 and 2.2, levels A and AA).
 * A page that answers with an HTTP error counts as failed: an error page must never pass
 * as a checked page.
 *
 * Talks to Chromium over the DevTools protocol with Node's own WebSocket (Node 22+), so
 * the only dependency is axe-core: installed next to this file, or AXE_CORE pointing at
 * axe.min.js. Chromium comes from CHROME_PATH or the usual install paths. HTTP basic auth
 * for a protected preview: A11Y_BASIC_AUTH=user:pass.
 *
 * Exit code 1 when a page fails (see --fail-on), 2 when the check could not run.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 820, height: 1180, mobile: true },
  phone: { width: 390, height: 844, mobile: true },
};
export const DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const IMPACTS = ["minor", "moderate", "serious", "critical"];
const PAGE_TIMEOUT_MS = 30_000;

// ── Options ───────────────────────────────────────────────────────────
export function parseArgs(argv, env = {}) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const list = (value) => (value || "").split(/[\s,]+/).filter(Boolean);
  const url = (opt("url") || env.A11Y_BASE_URL || "").replace(/\/$/, "");
  if (!URL.canParse(url)) throw new Error("--url needs the address of the site, e.g. http://localhost:3000");
  const viewports = list(opt("viewports") || "desktop phone");
  for (const name of viewports) {
    if (!VIEWPORTS[name]) throw new Error(`Unknown viewport "${name}": ${Object.keys(VIEWPORTS).join(", ")}`);
  }
  const failOn = opt("fail-on") || "violation";
  if (!["violation", "never", ...IMPACTS].includes(failOn)) {
    throw new Error(`--fail-on takes violation, ${IMPACTS.join(", ")} or never`);
  }
  const number = (name, fallback) => {
    const value = Number(opt(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} needs a number`);
    return value;
  };
  return {
    url,
    routes: list(opt("routes")),
    sitemap: opt("sitemap"),
    exclude: list(opt("exclude")),
    viewports,
    tags: list(opt("tags")).length ? list(opt("tags")) : DEFAULT_TAGS,
    failOn,
    concurrency: Math.max(1, number("concurrency", 4)),
    maxPages: number("max-pages", 200),
    wait: number("wait", 500),
    json: opt("json"),
    basicAuth: env.A11Y_BASIC_AUTH,
  };
}

// ── Routes ────────────────────────────────────────────────────────────
/** The <loc> entries of a sitemap or a sitemap index. */
export function parseSitemap(xml) {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
  return { index: /<sitemapindex[\s>]/.test(xml), locs };
}

/** Path and query of a sitemap entry: the origin is replaced by the site under test. */
export function toRoute(loc) {
  if (loc.startsWith("/")) return loc;
  if (!URL.canParse(loc)) return null;
  const { pathname, search } = new URL(loc);
  return pathname + search;
}

/** "/blog/*" excludes everything below /blog, "/imprint" only that page. */
export function isExcluded(route, patterns) {
  const path = route.split("?")[0];
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}

async function readSitemap(source, headers) {
  if (!/^https?:\/\//.test(source)) return readFileSync(source, "utf8");
  const response = await fetch(source, { headers });
  if (!response.ok) throw new Error(`${source} answered HTTP ${response.status}`);
  return response.text();
}

export async function collectRoutes(options, read = readSitemap) {
  let routes = options.routes;
  if (!routes.length) {
    const headers = authHeaders(options.basicAuth);
    const source = options.sitemap || `${options.url}/sitemap.xml`;
    const first = parseSitemap(await read(source, headers));
    let locs = first.locs;
    if (first.index) {
      locs = [];
      for (const child of first.locs) {
        // A sitemap index of the production site: read its parts from the site under test
        const target = options.sitemap ? child : options.url + toRoute(child);
        locs.push(...parseSitemap(await read(target, headers)).locs);
      }
    }
    routes = locs.map(toRoute).filter(Boolean);
    if (!routes.length) throw new Error(`No routes found in ${source}. Pass --routes or --sitemap.`);
  }
  routes = [...new Set(routes.map((r) => (r.startsWith("/") ? r : `/${r}`)))];
  routes = routes.filter((route) => !isExcluded(route, options.exclude)).sort();
  return { routes: routes.slice(0, options.maxPages || undefined), skipped: Math.max(0, routes.length - (options.maxPages || routes.length)) };
}

function authHeaders(basicAuth) {
  return basicAuth ? { Authorization: `Basic ${Buffer.from(basicAuth).toString("base64")}` } : {};
}

// ── Result ────────────────────────────────────────────────────────────
/** Whether a page fails the run: an error always does, a violation from the --fail-on impact on. */
export function pageFails(page, failOn) {
  if (page.error) return true;
  if (failOn === "never") return false;
  if (failOn === "violation") return page.violations.length > 0;
  const threshold = IMPACTS.indexOf(failOn);
  return page.violations.some((v) => IMPACTS.indexOf(v.impact) >= threshold);
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** The report as Markdown, for the job summary. */
export function renderMarkdown(report) {
  const { checked, passed, pages } = report;
  const lines = [`## Accessibility: ${passed}/${checked} pages pass`, ""];
  lines.push(
    `axe-core ${report.engine.version ?? ""} · ${report.tags.join(", ")} · ${report.viewports.map((v) => `${v.name} ${v.width}×${v.height}`).join(", ")} · ${report.url}`,
    "",
  );
  const errors = pages.filter((p) => p.error);
  if (errors.length) {
    lines.push("### Pages that could not be checked", "", "| Page | Viewport | Error |", "| --- | --- | --- |");
    for (const p of errors) lines.push(`| \`${cell(p.route)}\` | ${p.viewport} | ${cell(p.error)} |`);
    lines.push("");
  }
  // One row per rule, with the pages it fails on: a broken header shows up once, not on every page
  const rules = new Map();
  for (const page of pages) {
    for (const v of page.violations || []) {
      const rule = rules.get(v.id) || { ...v, routes: new Set(), nodes: 0, example: v.nodes[0] };
      rule.routes.add(page.route);
      rule.nodes += v.nodes.length;
      rules.set(v.id, rule);
    }
  }
  if (rules.size) {
    const sorted = [...rules.values()].sort(
      (a, b) => IMPACTS.indexOf(b.impact) - IMPACTS.indexOf(a.impact) || b.routes.size - a.routes.size,
    );
    lines.push("### Violations", "", "| Impact | Rule | Pages | Elements | Example |", "| --- | --- | --- | --- | --- |");
    for (const rule of sorted) {
      const routes = [...rule.routes];
      const shown = routes.slice(0, 3).map((r) => `\`${cell(r)}\``).join(", ");
      const more = routes.length > 3 ? ` and ${routes.length - 3} more` : "";
      lines.push(
        `| ${rule.impact ?? "?"} | [${rule.id}](${rule.helpUrl}): ${cell(rule.help)} | ${shown}${more} | ${rule.nodes} | \`${cell(rule.example?.html ?? "").replace(/`/g, "'")}\` |`,
      );
    }
    lines.push("");
  } else if (!errors.length) {
    lines.push("No violations found.", "");
  }
  if (report.skipped) lines.push(`${report.skipped} more routes were not checked (max-pages).`, "");
  lines.push(
    "<sub>An automated check finds only part of all accessibility problems. Keyboard use, screen reader output and content still need a person.</sub>",
  );
  return lines.join("\n") + "\n";
}

// ── Chromium over the DevTools protocol ───────────────────────────────
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("No Chromium found; set CHROME_PATH.");
  return found;
}

function launchChrome(profileDir) {
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      // Several tabs run at once; none may be throttled as a background tab
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    // Own process group, so cleanup can end the tab processes as well
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const endpoint = new Promise((ok, fail) => {
    let buffer = "";
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) ok(match[1]);
    });
    chrome.on("exit", (code) => fail(new Error(`Chromium exited (${code})`)));
  });
  return { chrome, endpoint };
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call.fail(new Error(`${call.method}: ${msg.error.message}`));
      else call.ok(msg.result);
      return;
    }
    for (const listener of listeners) listener(msg);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++nextId;
      pending.set(id, { ok, fail, method });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const once = (method, sessionId, timeout = PAGE_TIMEOUT_MS) =>
    new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        fail(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const listener = (msg) => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        listeners.delete(listener);
        ok(msg.params);
      };
      listeners.add(listener);
    });
  const on = (method, sessionId, fn) => {
    const listener = (msg) => {
      if (msg.method === method && msg.sessionId === sessionId) fn(msg.params);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const opened = new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error(`Cannot connect to ${url}`));
  });
  return { opened, send, once, on, close: () => ws.close() };
}

async function checkPage(cdp, sessionId, url, axeSource, options) {
  let status = 0;
  const off = cdp.on("Network.responseReceived", sessionId, ({ type, response }) => {
    if (type === "Document" && !status) status = response.status;
  });
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  try {
    const nav = await cdp.send("Page.navigate", { url }, sessionId);
    if (nav.errorText) throw new Error(nav.errorText);
    await loaded;
  } finally {
    off();
  }
  if (status >= 400) throw new Error(`HTTP ${status}`);

  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        await document.fonts.ready;
        // Hydration and reveal-on-scroll effects run after load
        await new Promise((r) => setTimeout(r, ${options.wait}));
        ${axeSource}
        const res = await axe.run(document, {
          runOnly: { type: "tag", values: ${JSON.stringify(options.tags)} },
          resultTypes: ["violations"],
        });
        return res.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.map((n) => ({
            target: n.target.join(" "),
            html: n.html.replace(/\\s+/g, " ").slice(0, 140),
            summary: n.failureSummary?.split("\\n").slice(1, 2).join("").trim(),
          })),
        }));
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

function printPage({ viewport, route, violations, error }) {
  const name = viewport.padEnd(7);
  if (error) return console.log(`✗ ${name} ${route}  error: ${error}`);
  if (!violations.length) return console.log(`✓ ${name} ${route}`);
  console.log(`✗ ${name} ${route}`);
  for (const v of violations) {
    console.log(`    ${v.impact ?? "?"}  ${v.id}: ${v.help}`);
    for (const node of v.nodes.slice(0, 5)) {
      console.log(`      ${node.html}`);
      if (node.summary) console.log(`        ${node.summary}`);
    }
    if (v.nodes.length > 5) console.log(`      … ${v.nodes.length - 5} more`);
  }
}

export async function run(options) {
  const axePath = process.env.AXE_CORE || createRequire(import.meta.url).resolve("axe-core/axe.min.js");
  const axeSource = readFileSync(axePath, "utf8");
  const { routes, skipped } = await collectRoutes(options);

  const profileDir = mkdtempSync(join(tmpdir(), "axe-routes-"));
  const { chrome, endpoint } = launchChrome(profileDir);
  const cdp = connect(await endpoint);
  await cdp.opened;

  // One tab, set up like a visitor who prefers reduced motion: content that fades in on
  // scroll is then visible at once, otherwise axe would skip what is still hidden
  const openTab = async () => {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
      sessionId,
    );
    if (options.basicAuth) {
      await cdp.send("Network.setExtraHTTPHeaders", { headers: authHeaders(options.basicAuth) }, sessionId);
    }
    return sessionId;
  };

  // Every page at every viewport; the report keeps this order, whatever finishes first
  const jobs = options.viewports.flatMap((viewport) => routes.map((route) => ({ viewport, route })));
  const pages = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    const sessionId = await openTab();
    let current = null;
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      if (current !== job.viewport) {
        const { width, height, mobile } = VIEWPORTS[job.viewport];
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width, height, deviceScaleFactor: 1, mobile },
          sessionId,
        );
        current = job.viewport;
      }
      try {
        const violations = await checkPage(cdp, sessionId, options.url + job.route, axeSource, options);
        pages[index] = { ...job, violations };
      } catch (err) {
        pages[index] = { ...job, error: err.message };
      }
      printPage(pages[index]);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  } finally {
    cdp.close();
    const exited = new Promise((ok) => chrome.once("exit", ok));
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      chrome.kill();
    }
    await exited;
    // Tab processes can still write into the profile for a moment after Chromium exits
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`Could not remove ${profileDir}: ${err.message}`);
    }
  }

  const failed = pages.filter((page) => pageFails(page, options.failOn)).length;
  return {
    timestamp: new Date().toISOString(),
    commit: process.env.GITHUB_SHA?.slice(0, 7) ?? null,
    url: options.url,
    engine: { name: "axe-core", version: axeSource.match(/axe v([\d.]+)/)?.[1] ?? null },
    tags: options.tags,
    viewports: options.viewports.map((name) => ({ name, ...VIEWPORTS[name] })),
    failOn: options.failOn,
    checked: pages.length,
    passed: pages.length - failed,
    skipped,
    pages,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const report = await run(options);
  const failed = report.checked - report.passed;
  console.log(`\n${report.passed}/${report.checked} pages pass (${options.url})`);
  if (report.skipped) console.log(`${report.skipped} more routes were not checked (--max-pages).`);

  if (options.json) writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  if (process.env.GITHUB_OUTPUT) {
    const violations = report.pages.reduce((sum, p) => sum + (p.violations?.length ?? 0), 0);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `checked=${report.checked}\npassed=${report.passed}\nfailed=${failed}\nviolations=${violations}\n`,
    );
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(2);
  });
}
