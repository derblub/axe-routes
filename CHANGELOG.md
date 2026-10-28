# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

- The project page follows the Pushing Pixels design: header, brand files, preview image, contribution and security notes.
- The action sets up Node with version 7 of `actions/setup-node`, when the job has no Node 22 or newer.
- Tested on Node 26 as well as on 22 and 24.
- The command runs when it is started through the link npm puts in `node_modules/.bin`, as `npx axe-routes` does. Before, it ended at once with exit code 0 and checked nothing.

## [0.1.0] - 2026-10-13

- First release: checks every route from a sitemap or a list with axe-core in headless Chromium, at desktop, tablet or phone size, as a GitHub Action and from the command line. Writes a job summary grouped by rule and a JSON report.

[Unreleased]: https://github.com/derblub/axe-routes/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/derblub/axe-routes/releases/tag/v0.1.0
