import path from 'node:path';
import type { Configuration } from 'webpack';
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

export const rendererConfig: Configuration = {
  output: {
    publicPath: '../',
  },
  module: {
    rules,
  },
  plugins: [
    ...plugins,
    new MonacoWebpackPlugin({
      languages: ['cpp', 'json', 'markdown', 'sql', 'xml', 'yaml'],
    }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
    // A module loaded only when needed is imported as ./name.js, as TypeScript
    // asks of import() here; the file is name.ts.
    extensionAlias: { '.js': ['.ts', '.js'] },
    // One three.js: its add-ons import the ES module build, which this
    // CommonJS code would otherwise get a second copy of, as three.cjs.
    alias: { three$: path.join(path.dirname(require.resolve('three')), 'three.module.js') },
  },
};
