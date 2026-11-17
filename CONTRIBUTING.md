# Contributing

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Quick start

Requires Node.js 22.18 or newer and pnpm (pinned in `package.json`; Corepack picks it up).

```bash
pnpm install --frozen-lockfile
pnpm run lint && pnpm run typecheck && pnpm test
```

Preview the documentation with `pnpm run docs:dev` (http://localhost:3000) and check it with `pnpm run docs:check`.

The architecture, every check that CI runs and the release process are described in [docs/contributing.mdx](docs/contributing.mdx).

## Pull requests

- Include tests for behavior changes. Tests never send real email.
- Add a changeset for user-facing changes: `pnpm changeset`.
- Use [Conventional Commits](https://www.conventionalcommits.org), for example `fix(cli): exit with 130 when stopped before the first list`.
