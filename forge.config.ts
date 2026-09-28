import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // The packager adds .icns on macOS and .ico on Windows.
    icon: './assets/glistengine',
    // A plain name for the Linux binary, which the AppImage launcher runs.
    executableName: 'gliststudio',
    extraResource: ['./assets/glistengine.ico', './assets/glistengine.png', './glistapp-template', './THIRD_PARTY_NOTICES.md'],
    // Ad-hoc, until there is a Developer ID. Signing here, after the two halves
    // of a universal build are merged, also keeps the fuses plugin from
    // signing only the arm64 half, which the merge rejects. The hardened
    // runtime is for notarization and refuses ad-hoc signed frameworks.
    osxSign: { identity: '-', identityValidation: false, optionsForFile: () => ({ hardenedRuntime: false }) },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      setupIcon: './assets/glistengine.ico',
    }),
    new MakerDMG({ icon: './assets/glistengine.icns', format: 'ULFO' }, ['darwin']),
    new MakerZIP({}, ['darwin']),
    new MakerAppImage({
      options: {
        icon: './assets/glistengine.png',
        categories: ['Development', 'IDE'],
        genericName: 'Glist Engine IDE',
      },
    }, ['linux']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      // Forge's default, plus the blob workers Monaco starts.
      devContentSecurityPolicy: "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' data:; worker-src 'self' blob:",
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
