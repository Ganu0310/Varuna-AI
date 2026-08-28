// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/web/dist/**',
      'services/ml/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': 'off',
    },
  },
  {
    // VARUNA-specific guardrails (see 02_TRD §2.6.4, 05_FRONTEND §5.2, 13_REAL_DATA_POLICY).
    // Test files are exempt from the sourceType-literal ban: they must be able to assert
    // that forbidden values like 'MOCK' are rejected (check-real-data-policy.mjs also skips
    // *.test.* for the same reason).
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/^(MOCK|SYNTHETIC|FAKE|DEMO|PLACEHOLDER|TEST)$/][parent.type='Property'][parent.key.name='sourceType']",
          message:
            'Forbidden provenance sourceType literal — see 13_REAL_DATA_POLICY §13.4. Only real-source categories are permitted.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@faker-js/faker',
              message:
                'Fake-data libraries are banned in runtime code (13_REAL_DATA_POLICY §13.4, TR-P5).',
            },
            {
              name: 'faker',
              message:
                'Fake-data libraries are banned in runtime code (13_REAL_DATA_POLICY §13.4, TR-P5).',
            },
            {
              name: 'chance',
              message:
                'Fake-data libraries are banned in runtime code (13_REAL_DATA_POLICY §13.4, TR-P5).',
            },
            {
              name: 'casual',
              message:
                'Fake-data libraries are banned in runtime code (13_REAL_DATA_POLICY §13.4, TR-P5).',
            },
          ],
        },
      ],
    },
  },
);
