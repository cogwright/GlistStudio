import { execFileSync } from 'node:child_process';
import { DefinePlugin, type Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

// The commit a build is made from, for Settings > About; empty outside a checkout.
const commit = ((): string => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();

export const mainConfig: Configuration = {
  // index.js runs in the main process; backend.js in a utility process for
  // each window (src/backend.ts), which index.js starts from beside it.
  entry: { index: './src/index.ts', backend: './src/backend.ts' },
  output: { filename: '[name].js' },
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins: [...plugins, new DefinePlugin({ GLIST_STUDIO_COMMIT: JSON.stringify(commit) })],
  // node-pty finds its binaries and a worker script by path, so it stays out of
  // the bundle; forge.config.ts copies it into the app.
  externals: { 'node-pty': 'commonjs node-pty' },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
