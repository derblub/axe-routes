# Contributing

Thanks for taking the time. The most useful contribution is a page the check gets wrong: one that passes although it has a problem axe-core can find, or one that fails for a reason that is not on the page.

## Reporting a wrong result

Open an [issue](https://github.com/derblub/axe-routes/issues/new/choose) with:

- the command or the workflow step you ran,
- the part of the output or of the JSON report that is wrong,
- the smallest HTML that shows it, or a public address.

A rule that reports something you think is fine is a question for [axe-core](https://github.com/dequelabs/axe-core/issues). axe-routes only decides which pages to open, how, and what counts as a failure.

## Development setup

You need Node 22 or newer and a Chromium or Chrome.

```console
$ git clone https://github.com/derblub/axe-routes
$ cd axe-routes
$ npm install
$ npm test
$ node check.mjs --url http://localhost:3000
```

`CHROME_PATH` names the browser when it is not in a usual place. Without a browser the tests against a real page are skipped.

Before you open a pull request, run `npm test` and add an entry under "Unreleased" in `CHANGELOG.md`.

## Where things live

| File | What it does |
| --- | --- |
| `check.mjs` | The whole check: options, routes from a sitemap or a list, Chromium over the DevTools protocol, the report |
| `action.yml` | The GitHub Action: sets up Node when needed, installs axe-core, runs `check.mjs` |
| `test/check.test.mjs` | Unit tests, and four runs against the sample site in `test/site` |
| `docs/assets/` | Brand files. Do not edit or redraw them |

The check has one dependency, axe-core, and no build step. Please keep it that way.
