import typescript from "@rollup/plugin-typescript";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { defineConfig } from "rollup";

const nodeBuiltins = [
  "net", "tls", "http", "https", "zlib", "fs", "path", "os",
  "crypto", "stream", "buffer", "events", "url", "util", "assert",
  "child_process", "dns", "dgram", "readline", "string_decoder",
  "tty", "v8", "vm", "worker_threads", "module", "timers",
];

const builtinPaths = Object.fromEntries(
  nodeBuiltins.map(mod => [mod, `node:${mod}`])
);

export default defineConfig({
  input: "src/main.ts",
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "index.js",
    sourcemap: true,
    inlineDynamicImports: true,
    paths: builtinPaths,
  },
  plugins: [
    nodeResolve({
      preferBuiltins: true,
    }),
    commonjs(),
    typescript({
      tsconfig: "./tsconfig.json",
    }),
  ],
  external: [/^node:/, ...nodeBuiltins],
});
