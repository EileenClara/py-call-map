import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

const extensionConfig = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
};

const webviewConfig = {
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "media/main.js",
  platform: "browser",
  format: "iife",
};

if (watch) {
  const extensionContext = await esbuild.context(extensionConfig);
  const webviewContext = await esbuild.context(webviewConfig);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
