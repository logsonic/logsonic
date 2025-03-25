import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "import": importPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": "off",
      
      // Import rules for better tree shaking
      "import/no-duplicates": "warn",
      "import/no-namespace": "warn", // Prefer named imports over namespace imports
      "import/no-default-export": "off", // Allow default exports
      "import/first": "warn", // Ensure imports are at the top of the file
      "import/newline-after-import": "warn", // Ensure there's a newline after imports
      "import/no-unresolved": "off", // TypeScript handles this
    },
  }
);
