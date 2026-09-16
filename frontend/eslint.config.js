import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-plugin-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side scripts (Playwright E2E drivers, build helpers) use console,
    // process, fetch and — inside page.evaluate callbacks — document. Without
    // this block they were linted with browser-only globals and produced 80
    // spurious no-undef errors.
    files: ["*.mjs", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      import: importPlugin,
      prettier: prettier,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          vars: "all",
          args: "after-used",
          caughtErrors: "none",
        },
      ],

      // Import rules for better tree shaking
      "import/no-duplicates": "error",
      "import/no-namespace": "warn", // Prefer named imports over namespace imports
      "import/no-default-export": "off", // Allow default exports
      "import/first": "error", // Ensure imports are at the top of the file
      "import/newline-after-import": "error", // Ensure there's a newline after imports
      "import/no-unresolved": "off", // TypeScript handles this
      "import/no-unused-modules": "error", // Warn about unused imports
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
      // No inline options: prettier/prettier reads .prettierrc, so eslint and
      // `npm run format` can never disagree about the house style again. (They
      // did: this block used to say singleQuote: true while .prettierrc says
      // false, which made every double-quoted line in the repo a lint error.)
      "prettier/prettier": "error",
      "no-unused-vars": "off", // Turn off the base rule as it can report incorrect errors
    },
  }
];
