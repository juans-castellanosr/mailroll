# @mailroll/outlook

The official Microsoft Outlook integration for mailroll: it sends through a Microsoft 365 mailbox with Microsoft Graph and delegated sign-in, and ships the `mailroll-outlook` tool to export a mailbox's Sent Items.

Install it next to mailroll and declare it in `mailroll.json`, like any other integration:

```bash
npm install mailroll @mailroll/outlook
```

```json mailroll.json
{ "integrations": ["@mailroll/outlook"] }
```

The library can also be used on its own, without mailroll: it depends only on `@mailroll/core`. The `mailroll-outlook` tool reads your campaigns through mailroll, so it needs mailroll installed in the same project.

The mailroll documentation covers installing and connecting Outlook (the "Connect Outlook" guide) and the `mailroll-outlook export-sent` reference.

## License

[MIT](LICENSE) © 2026 Juan Sebastian Castellanos Rivillas
