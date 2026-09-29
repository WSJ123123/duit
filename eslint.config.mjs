import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Serwist-generated service worker output (also gitignored).
    "public/sw*",
    "public/swe-worker*",
    // Local Supabase stack runtime artefacts (finding #3: `supabase start`
    // writes these inside the repo; both are gitignored). Bundled vendor JS
    // that eslint should never have been scanning — it accounted for every
    // error in `npm run lint` and none of it is ours to fix.
    "supabase/.temp/**",
    "supabase/.branches/**",
  ]),
]);

export default eslintConfig;
