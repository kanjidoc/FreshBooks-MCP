const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

/**
 * Lean ESLint flat config — JS + TypeScript recommended rules.
 * `no-explicit-any` is off: the SDK glue layer deliberately uses `any` for
 * axios internals and partial-payload casts (see CLAUDE.md / freshbooks_help).
 */
module.exports = tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // `_`-prefixed args/vars are intentionally unused (e.g. an unused handler arg).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
