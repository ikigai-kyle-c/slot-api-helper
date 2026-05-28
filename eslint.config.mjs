import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        // Tell ESLint that 'Bun' is a valid global variable
        Bun: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-useless-assignment": "off",
      // Add this line to allow empty catch blocks:
      "no-empty": ["error", { "allowEmptyCatch": true }]
    },
  },
  {
    ignores: ["node_modules/", "coverage/", "dist/", "build/"],
  },
];