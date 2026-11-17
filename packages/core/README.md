# @mailroll/core

The provider-independent core of [mailroll](../mailroll): the run engine, the `sender/0` integration contract and its validators, send-history planning and template rendering.

It has no dependencies and uses no Node.js built-ins, so it runs in Node.js and in browsers. The `mailroll` package depends on it and re-exports it as `mailroll/core`; both names give the same instances.

The full documentation lives in [`docs/`](../../docs).

## License

[MIT](LICENSE) © 2026 Juan Sebastian Castellanos Rivillas
