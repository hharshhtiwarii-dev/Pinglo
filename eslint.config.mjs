import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat config (audit #26) — the repo previously had no eslint at
 * all; `lint` was only `tsc --noEmit`, so react-hooks violations were
 * invisible. Nothing here is disabled to hide a violation: every rule
 * below is either error, or warn with the reason + the counted debt
 * recorded in the audit-nice report
 * (~/workspace/dtchats/user-test/workers/full-army-audit-nice-hygiene-report.md).
 *
 * Legacy debt, kept as WARN (visible on every run, never silent):
 * - @typescript-eslint/no-explicit-any (~760 sites): `any` is the
 *   codebase's established style for untyped Firestore/Amplify payloads.
 *   Typing them all is a separate migration, not a one-pass fix.
 * - react-hooks v6 compiler-readiness rules (~148 sites: purity,
 *   set-state-in-effect, refs, immutability, preserve-manual-memoization,
 *   static-components): the repo does NOT use the React Compiler, so the
 *   "reset state when a prop changes" effects etc. are legitimate code
 *   here, not bugs. The 2 genuine static-components errors
 *   (SignupScreen's InputStatus recreated per render) were fixed, not
 *   warned away. If the compiler is ever adopted, flip these to error
 *   and work the list down.
 * - preserve-caught-error, core rule (19 sites): re-thrown
 *   errors that drop the caught error; each needs a per-site `cause`
 *   decision, so warn until that pass lands.
 */
export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'android',
      'e2e',
      'graphify-out',
      'coverage',
      'src/vite-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Legacy debt — warn, see the header comment (counts in the report).
      '@typescript-eslint/no-explicit-any': 'warn',
      // Core rule (no plugin prefix): re-thrown errors that drop the
      // caught error; each needs a per-site `cause` decision.
      'preserve-caught-error': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',
      // `_`-prefixed names are this codebase's "intentionally unused"
      // convention (unused catch params, dropped values).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
