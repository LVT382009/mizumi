import typescript from "@rollup/plugin-typescript";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { defineConfig } from "rollup";

export default defineConfig({
  input: "src/main.ts",
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "index.js",
    sourcemap: true,
    inlineDynamicImports: true,
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
  external: [/^node:/],
});
