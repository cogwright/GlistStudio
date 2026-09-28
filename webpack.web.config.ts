import path from 'node:path';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import type { Configuration, RuleSetRule } from 'webpack';

import { rendererConfig } from './webpack.renderer.config';

// These rewrite modules for Node, which a browser page does not have.
const nodeLoaders = ['@vercel/webpack-asset-relocator-loader', 'node-loader'];
const loaderOf = (rule: RuleSetRule): unknown =>
  (typeof rule.use === 'object' && rule.use !== null && 'loader' in rule.use ? rule.use.loader : rule.use);

// The renderer as a plain web page, for npm run web.
export const webConfig: Configuration = {
  ...rendererConfig,
  mode: 'development',
  devtool: 'source-map',
  entry: './src/web/client.ts',
  output: { path: path.resolve('out', 'web'), publicPath: '/', clean: true },
  module: {
    rules: (rendererConfig.module?.rules ?? []).filter((rule) =>
      !(rule && typeof rule === 'object' && nodeLoaders.includes(String(loaderOf(rule))))),
  },
  plugins: [...(rendererConfig.plugins ?? []), new HtmlWebpackPlugin({ template: './src/index.html' })],
  performance: { hints: false },
};
