<div align="center">

<a href="https://pushingpixels.at">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img src="docs/assets/logo.svg" alt="Pushing Pixels" width="96">
  </picture>
</a>

<h1>axe-routes</h1>

<p><strong>Check every route of your site for accessibility problems, on every push.</strong></p>

<p>
  <a href="https://github.com/derblub/axe-routes/actions/workflows/ci.yml"><img src="https://github.com/derblub/axe-routes/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/axe-routes"><img src="https://img.shields.io/npm/v/axe-routes?cacheSeconds=3600" alt="npm"></a>
  <a href="https://www.npmjs.com/package/axe-routes"><img src="https://img.shields.io/node/v/axe-routes?cacheSeconds=3600" alt="Node versions"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p>
  <a href="#what-it-does-and-what-it-does-not">What it does</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#without-github-actions">Command line</a> ·
  <a href="#the-json-report">JSON report</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

</div>

---

One broken component in a header or a footer fails on every page, and one page nobody looks at fails for months. A check of the home page finds neither. **axe-routes** reads your sitemap, opens every page in headless Chromium at desktop and phone size, runs [axe-core](https://github.com/dequelabs/axe-core) on it and fails the build when a page violates WCAG 2.0, 2.1 or 2.2 at level A or AA.

```yaml
- uses: derblub/axe-routes@v0
  with:
    url: http://localhost:3000
```

The job summary shows one row per violated rule, with the pages it fails on:

> ## Accessibility: 2/6 pages pass
>
> axe-core 4.14.0 · wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa · desktop 1440×900, phone 390×844 · http://localhost:3000
>
> | Impact | Rule | Pages | Elements | Example |
> | --- | --- | --- | --- | --- |
> | critical | [button-name](https://dequeuniversity.com/rules/axe/4.14/button-name): Buttons must have discernible text | `/broken.html` | 2 | `<button></button>` |
> | serious | [color-contrast](https://dequeuniversity.com/rules/axe/4.14/color-contrast): Elements must meet minimum color contrast ratio thresholds | `/broken.html` | 2 | `<p style="color: #bbb; background: #fff">Text with too little contrast</p>` |

## What it does, and what it does not

- **Every route, not a sample.** Routes come from `sitemap.xml` (sitemap indexes included) or from a list. Only the paths are used, so the sitemap of your production site also drives a check of `localhost` or a preview deployment.
- **Two sizes.** Each page is checked at a desktop and a phone viewport, because navigation, tables and dialogs are often different markup below a breakpoint.
- **An error page is not a pass.** A route that answers with HTTP 404 or 500 fails the check instead of having its error page tested.
- **Content that fades in is checked too.** Pages load with `prefers-reduced-motion: reduce`, so reveal-on-scroll content is visible when axe runs.
- **No test framework.** One file, one dependency (axe-core), the Chrome that is already on the runner. No Playwright or Puppeteer download.

> [!IMPORTANT]
> An automated check finds only part of all accessibility problems: missing names, wrong ARIA, low contrast, broken structure. Whether a page works with a keyboard and a screen reader, and whether its texts and alternative texts make sense, still needs a person. A green run is a floor, not a proof of conformance with WCAG, the European Accessibility Act or a national law such as the Austrian BaFG or the German BFSG.

## Usage

Build and start your site in the job, then point the action at it:

```yaml
name: Accessibility
on: [push]

jobs:
  axe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run build
      - run: npm run preview -- --port 3000 &
      - run: npx --yes wait-on http://localhost:3000
      - uses: derblub/axe-routes@v0
        id: axe
        with:
          url: http://localhost:3000
          exclude: /admin/*
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: a11y-report
          path: ${{ steps.axe.outputs.report }}
```

| Input | Default | Description |
| --- | --- | --- |
| `url` | | Address of the running site. Required. |
| `routes` | | Paths to check, separated by spaces or one per line. Empty reads them from the sitemap. |
| `sitemap` | `<url>/sitemap.xml` | URL or file of a sitemap to read the routes from. |
| `exclude` | | Paths to leave out. `/blog/*` leaves out everything below `/blog`, `/imprint` only that page. |
| `viewports` | `desktop phone` | `desktop` (1440×900), `tablet` (820×1180), `phone` (390×844). |
| `tags` | WCAG 2.0, 2.1, 2.2 A and AA | [axe-core rule tags](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#axe-core-tags) to run. Add `best-practice` for more. |
| `fail-on` | `violation` | `violation`, or the lowest impact that fails the step: `minor`, `moderate`, `serious`, `critical`. `never` only reports. |
| `max-pages` | `200` | Check at most this many routes. `0` checks all. |
| `concurrency` | `4` | Browser tabs to check pages in at once. |
| `wait` | `500` | Milliseconds to wait after load, for hydration and client-side rendering. |
| `basic-auth` | | `user:password` for a site behind HTTP basic auth. Pass a secret. |
| `axe-version` | `4.14.0` | Version of axe-core. Pinned, so a new rule does not fail your build overnight. |

| Output | Description |
| --- | --- |
| `report` | Path to the JSON report. |
| `checked`, `passed`, `failed` | Number of pages: routes × viewports. |
| `violations` | Number of violated rules, summed over all pages. |

The action uses the Node of your job when it is version 22 or newer, and sets up Node 24 otherwise. It runs on Linux runners, which come with Chrome.

### Starting with a site that has problems

A first run on an existing site usually fails. Set `fail-on: critical` to stop new critical problems at once, fix what the summary lists, then tighten to `serious` and finally to the default.

### Without GitHub Actions

The check is a single file and runs anywhere Node 22 and a Chromium are installed:

```console
npx axe-routes --url http://localhost:3000 --json report.json
```

Or add it to a project with `npm install --save-dev axe-routes`, and `npx axe-routes` runs that version.

```yaml
# GitLab CI
a11y:
  image: node:24
  before_script:
    - apt-get update && apt-get install -y chromium
  script:
    - npm ci && npm run build
    - npm run preview -- --port 3000 &
    - npx --yes wait-on http://localhost:3000
    - npx axe-routes --url http://localhost:3000 --json a11y-report.json
  artifacts:
    when: always
    paths: [a11y-report.json]
```

The options are the inputs above as `--flags`, except `basic-auth` and `axe-version`. `CHROME_PATH` names the browser when it is not in a usual place, `A11Y_BASIC_AUTH=user:pass` is the basic auth. The command checks with the axe-core installed next to it, a 4.x from 4.14.0 on. To pin it as the action does, install it with axe-routes: `npm install --save-dev axe-routes axe-core@4.14.0`. `AXE_CORE` can also name an `axe.min.js`. Exit code 1 means a page failed, 2 means the check could not run.

## The JSON report

```json
{
  "timestamp": "2026-10-13T13:40:12.000Z",
  "commit": "abcdef1",
  "url": "http://localhost:3000",
  "engine": { "name": "axe-core", "version": "4.14.0" },
  "tags": ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  "viewports": [{ "name": "desktop", "width": 1440, "height": 900, "mobile": false }],
  "failOn": "violation",
  "checked": 2,
  "passed": 1,
  "skipped": 0,
  "pages": [
    { "viewport": "desktop", "route": "/", "violations": [] },
    {
      "viewport": "desktop",
      "route": "/contact",
      "violations": [
        {
          "id": "button-name",
          "impact": "critical",
          "help": "Buttons must have discernible text",
          "helpUrl": "https://dequeuniversity.com/rules/axe/4.14/button-name",
          "nodes": [{ "target": "form > button", "html": "<button></button>", "summary": "…" }]
        }
      ]
    }
  ]
}
```

Published next to the site, the report is evidence anyone can check: [pushingpixels.at](https://pushingpixels.at/accessibility) links the report of its last deployment from its accessibility statement.

## Contributing

A page that passes although it has a problem, or fails although it has none, is the most useful report. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, and the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Daniel Kurdoghlian, Pushing Pixels

---

<div align="center">
  <a href="https://pushingpixels.at">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pushing-pixels-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/assets/pushing-pixels-light.svg">
      <img src="docs/assets/pushing-pixels.svg" alt="Pushing Pixels" width="320">
    </picture>
  </a>
  <p>Built and maintained by <a href="https://pushingpixels.at">Daniel Kurdoghlian</a> at <a href="https://pushingpixels.at">Pushing Pixels</a> in Vienna.<br>
  An automated check is where an audit starts. I do <a href="https://pushingpixels.at/creates/accessibility-audit">fixed-price accessibility audits</a> with keyboard and screen reader testing.</p>
</div>
