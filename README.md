# mailroll

Send personalized email campaigns from CSV lists, with a send history per list that makes running again safe.

This repository is a pnpm workspace. The published packages live in [`packages/`](packages):

| Package                                 | Path                | Description                                                                |
| --------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| [`mailroll`](packages/mailroll)         | `packages/mailroll` | The CLI, the Node.js SDK and the browser-safe `mailroll/core`              |
| [`@mailroll/core`](packages/core)       | `packages/core`     | The provider-independent engine and integration contracts; no dependencies |
| [`@mailroll/outlook`](packages/outlook) | `packages/outlook`  | The official Microsoft Outlook integration and the `mailroll-outlook` tool |

Requires Node.js 22.18 or newer:

```bash
npm install mailroll
```

## Documentation

The full documentation lives in [`docs/`](docs) and is published with Mintlify: [quickstart](docs/quickstart.mdx), CLI reference, SDK, configuration and troubleshooting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Juan Sebastian Castellanos Rivillas
