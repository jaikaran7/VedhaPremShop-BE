import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/generated'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // SonarQube-style rules (cognitive complexity, duplicated code, promise handling, ...): see CLAUDE.md.
  sonarjs.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Verbatim port of the frontend's report formulas (kept identical so the frontend's own tests run against it): style rules are not applied, correctness rules are.
  {
    files: ['src/modules/reports/calc/**'],
    rules: {
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
    },
  },
  // Tests assert through supertest's `.expect(status)` chain, which the rule cannot see; the test harness runs `npx prisma` on purpose.
  {
    files: ['test/**', '**/*.spec.ts'],
    rules: {
      'sonarjs/assertions-in-tests': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  // These cases are the LAN origins the matcher is supposed to accept or reject.
  {
    files: ['src/common/http/cors-origin.spec.ts'],
    rules: {
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
    },
  },
);
