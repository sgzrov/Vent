import { build } from "esbuild";
import { builtinModules } from "node:module";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.mjs",
  external: [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    "ws",
    "bufferutil",
    "utf-8-validate",
  ],
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Bundled → dist/index.mjs");
