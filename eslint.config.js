// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'coverage/**',
      'ref/**',
      '*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // CLI entry points, commands, output layer, scripts: allow console (user-facing output)
  {
    files: [
      'src/cli.ts',
      'src/repl.ts',
      'src/commands/**/*.{ts,tsx}',
      'src/output/**/*.{ts,tsx}',
      'scripts/**/*.{ts,tsx}',
      'bin/**/*.{ts,tsx}',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  // Files tightly coupled to third-party library type signatures (commander / ink / readline / upstream APIs):
  // Disable no-explicit-any. These 'any' usages are legitimate type escapes; forcing strict typing would
  // introduce indirect conversions that reduce readability. Other business code remains under the global warn.
  {
    files: [
      'src/repl.ts', // commander + readline private APIs
      'src/ui/render.tsx', // Ink + Node stream listener
      'src/api/http-client.ts', // upstream API dynamic fields
      'src/commands/**/*.{ts,tsx}', // commander action signatures
      'src/view-models/usage.ts', // API response extended fields
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Disable format rules that conflict with Prettier; must be placed last
  prettier,
);
