import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default [
  { ignores: [".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts", "test-results/**", "playwright-report/**", ".e2e/**"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
];
