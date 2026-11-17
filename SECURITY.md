# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue.

## Supported versions

Only the latest released version receives security fixes while the project is below 1.0.

## Trust model

- **Campaign folders are code.** A template's `code/plugin.{ts,mts,js,mjs}` is imported and executed. Run
  mailroll only on campaigns you trust.
- **Recipient data (CSV) is untrusted.** Values are HTML-escaped in `{{placeholders}}`, control characters are
  escaped before reaching the terminal, and ids and data files are matched against what exists on disk.
- **Secrets** (tenant and client ids) come from the environment or a `.env` file; OAuth token caches are written
  with mode `0600` under `.secrets/tokens` by default. Keep both out of version control.
- `mailroll/core` never touches the network or the file system; real sending belongs on a server.

## Known third-party advisories

`pnpm audit --prod` reports no advisories for mailroll's runtime dependencies. The full `pnpm audit`, which includes development dependencies and the optional `mjml` peer, reports two moderate advisories.

### Present in the dependency tree

| Advisory                                                                                                                                           | Package and version                  | Paths                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): AbortSignal cancellation bypass allows post-timeout filesystem traversal | `glob` 13.0.7 (fixed in 14.0.2)      | `mjml` → `mjml-cli` → `glob`; `mjml` → `mjml-core` → `js-beautify` → `glob` |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): potential denial of service via globparts amplification                  | `minimatch` 10.2.6 (fixed in 11.0.1) | the paths above, plus `js-beautify` → `editorconfig` → `minimatch`          |

No fix is applied: these are the latest releases of their major versions, and the current `mjml-cli` (`glob ^13`, `minimatch ^10`) and `js-beautify` 2.0.3 (`glob ^13`) do not accept the fixed majors. Forcing them could break `mjml`.

### What was verified

- mailroll's own code does not import `glob`, `minimatch`, `editorconfig`, `js-beautify` or `mjml-cli`.
- With `mjml` 5.4.1, a call to `mjml2html` on a simple template (no `mj-include`, no `filePath`, `minify: false`) loaded no module from `glob`, `minimatch`, `editorconfig` or `mjml-cli`. It did load `js-beautify`.

### Conditions needed for exploitation

Based on the advisory titles (the audit data used here did not include the full descriptions):

- **`glob`:** code must rely on an `AbortSignal` to stop a traversal, which can then continue after the signal fires.
- **`minimatch`:** it must process a crafted glob pattern, which can consume excessive CPU.

mailroll's code does not call either package directly, so it passes neither a signal nor a pattern to them.

### Not verified

- `build-template` as mailroll runs it: with `filePath` set, which enables `mj-include` resolution, and with templates that use `mj-include`.
- Other `mjml` options (such as `beautify` or `minify: true`), other `mjml` versions in the `^5.4.1` range, and configurations read by `js-beautify` (such as `.editorconfig` files).
- Running the `mjml` or `js-beautify` command-line tools, which depend on `glob` and `minimatch`; how they use them was not examined.

Within what was verified, exposure is concentrated in the optional MJML compilation step and in tools you run yourself; the unverified cases above remain open. The advisories' own severity is moderate.
