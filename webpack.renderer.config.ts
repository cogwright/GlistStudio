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
      languages: ['cpp', 'json', 'markdown', 'xml', 'yaml'],
    }),
  ],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
