"use strict";

const path = require("path");

/**
 * Webpack config that bundles the Node-based extension host code from
 * `src/extension.js` into a single `dist/extension.js`. The `vscode` module is
 * provided by the runtime, and the webview assets under `media/` are shipped
 * as-is (not bundled).
 *
 * @type {import('webpack').Configuration}
 */
const config = {
  target: "node",
  mode: "none", // overridden to "production" by the package script

  entry: "./src/extension.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
  },
  externals: {
    vscode: "commonjs vscode", // provided by the VS Code runtime
  },
  resolve: {
    extensions: [".js"],
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = [config];
