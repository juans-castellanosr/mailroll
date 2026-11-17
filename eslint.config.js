import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const layerRule = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

const CORE_PRIVATE_PATHS = {
  group: ['@core/*', '@core', '**/core/src', '**/core/src/**'],
  message: 'mailroll uses Core only through its public entry "@mailroll/core".',
};

const PROVIDER_CODE = {
  group: ['@mailroll/outlook', '@mailroll/outlook/*', '@azure/msal-node', '**/outlook/src', '**/outlook/src/**'],
  message: 'mailroll stays provider-neutral: integrations are activated from mailroll.json, never imported.',
};

const OTHER_PACKAGE_PRIVATE_PATHS = {
  group: ['**/core/src', '**/core/src/**', '**/mailroll/src', '**/mailroll/src/**'],
  message: 'Use other packages only through their public entries ("@mailroll/core", "mailroll").',
};

const NODE_ONLY_GLOBALS = [
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
  'module',
  'exports',
  'global',
  'setImmediate',
  'clearImmediate',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/.pack/**',
      '**/coverage/**',
      '**/previews/**',
      'campaigns/**',
      'packages/*/campaigns/**',
      '**/compiled.html',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
        { blankLine: 'any', prev: 'multiline-block-like', next: ['break', 'continue'] },
      ],
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
    },
  },

  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['packages/mailroll/tests/fixtures/integrations/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      ...layerRule([
        {
          regex: '^(?!\\.)',
          message: 'Core imports only its own modules through relative paths: no packages and no Node.js built-ins.',
        },
        {
          group: ['**/mailroll', '**/mailroll/**'],
          message: 'Core must not depend on mailroll (dependencies point toward Core).',
        },
      ]),
      'no-restricted-globals': [
        'error',
        ...NODE_ONLY_GLOBALS.map((name) => ({
          name,
          message: 'Core runs outside Node.js: do not use Node-only globals.',
        })),
      ],
    },
  },
  {
    files: ['packages/mailroll/**/*.ts'],
    rules: layerRule([CORE_PRIVATE_PATHS, PROVIDER_CODE]),
  },
  {
    files: ['packages/mailroll/src/integrations/**/*.ts'],
    rules: layerRule([
      CORE_PRIVATE_PATHS,
      PROVIDER_CODE,
      {
        group: ['**/platform', '**/platform/**'],
        message: 'Integrations must not depend on the platform layer.',
      },
    ]),
  },
  {
    files: ['packages/mailroll/tests/fixtures/campaigns/**/*.ts'],
    rules: layerRule([
      CORE_PRIVATE_PATHS,
      PROVIDER_CODE,
      {
        group: ['@mailroll/core', '**/src/**', '**/platform/**', '**/integrations/**'],
        message: 'A template imports only the public package ("mailroll" or "mailroll/core").',
      },
    ]),
  },

  {
    files: ['packages/outlook/**/*.ts'],
    rules: layerRule([OTHER_PACKAGE_PRIVATE_PATHS]),
  },
  {
    files: ['packages/outlook/src/**/*.ts'],
    ignores: ['packages/outlook/src/cli/**'],
    rules: layerRule([
      OTHER_PACKAGE_PRIVATE_PATHS,
      {
        group: ['mailroll', 'mailroll/*', '**/cli', '**/cli/**'],
        message:
          'The Outlook library must import without mailroll, so it may not reach mailroll or the command-line tool in src/cli.',
      },
    ]),
  },

  prettier,
);
