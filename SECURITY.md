# Security policy

## Supported versions

Security fixes go into the latest release. Please upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's vulnerability reporting](https://github.com/derblub/axe-routes/security/advisories/new) or by email to [daniel@pushingpixels.at](mailto:daniel@pushingpixels.at).

You will get an answer within five working days. Once a fix is released, the report is credited in the changelog unless you prefer otherwise.

## What the check does with your data

axe-routes opens the pages of the address you give it in a headless Chromium on the machine it runs on, and reads the sitemap from that address or the file you name. It sends nothing anywhere else. The `basic-auth` value is sent only to that address. The JSON report holds page paths and short excerpts of the HTML that violates a rule: look at it before you publish it.
