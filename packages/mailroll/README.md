# mailroll

Send personalized email campaigns from CSV lists, with a send history per list that makes running again safe.

## Features

- **Preview first:** dry runs render every message to HTML; test mode sends everything to one inbox.
- **Safe reruns:** each list remembers who received the email. Send only to pending recipients, retry failures, or resend on purpose.
- **No guessing after a crash:** a send with an unknown outcome is marked _uncertain_ and never resent automatically.
- **Row validation:** every template defines the columns it needs; invalid rows are reported, never sent.
- **Any sending service through integrations:** mailroll includes none; install the ones you need, such as the official [`@mailroll/outlook`](../outlook) for Microsoft 365 mailboxes, and declare them in `mailroll.json`.
- **Three ways to use it:** a CLI with a guided menu, a Node.js SDK, and a browser-safe core.

## Install

Requires Node.js 22.18 or newer.

```bash
npm install mailroll @mailroll/outlook
```

```json mailroll.json
{ "integrations": ["@mailroll/outlook"] }
```

## Example

With a campaign in `campaigns/acme/onboarding`, preview every message without sending anything:

```bash
npx mailroll send -c acme/onboarding -t welcome --connection outlook-1 -m dry-run --cc "" --write-previews
```

Or run `npx mailroll` in a terminal for the guided menu.

## Documentation

The full documentation lives in [`docs/`](../../docs) and is published with Mintlify: [quickstart](../../docs/quickstart.mdx), CLI reference, SDK, configuration and troubleshooting.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](../../SECURITY.md).

## License

[MIT](LICENSE) © 2026 Juan Sebastian Castellanos Rivillas
