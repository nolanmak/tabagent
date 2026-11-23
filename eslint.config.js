// ESLint flat config (#25). Deliberately lenient: it catches real mistakes
// (unused imports, accidental globals, unreachable code) without fighting the
// existing style. Formatting is not linted.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "test-results/**", "playwright-report/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions, PAGELIB_SRC: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    // Playwright fixtures must destructure `{}` for "no dependencies".
    files: ["e2e/**/*.ts"],
    rules: { "no-empty-pattern": "off" },
  },
);
