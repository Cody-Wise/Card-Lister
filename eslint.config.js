import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  prettier,

  {
    files: ["src/**/*.js", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },

  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },

  {
    files: ["eslint.config.js"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },

  {
    ignores: ["node_modules/", "data/", "outputs/", "work/", "coverage/"],
  },
];
