# Third-party files

Copied unchanged from the installed npm packages, so the pages work wherever `client/` is served
(the Express app locally, Vercel online) without `node_modules` and without a CDN
(the Content-Security-Policy allows only this site's own scripts).

| File | Source | Version | License |
|---|---|---|---|
| `chart.umd.min.js` | `node_modules/chart.js/dist/chart.umd.min.js` | Chart.js 4.5.1 (bundles @kurkle/color 0.3.2) | MIT — `chart.js.LICENSE.md`, `kurkle-color.LICENSE.md` |

The copyright notices at the top of `chart.umd.min.js` are kept as published.

**Updating Chart.js:** `npm install chart.js@<version>`, then copy the three files again:

```powershell
Copy-Item node_modules/chart.js/dist/chart.umd.min.js client/vendor/chart.umd.min.js
Copy-Item node_modules/chart.js/LICENSE.md client/vendor/chart.js.LICENSE.md
Copy-Item node_modules/@kurkle/color/LICENSE.md client/vendor/kurkle-color.LICENSE.md
```

`npm test` fails while the copy differs from the installed package (`server/tests/vendor.test.js`).
