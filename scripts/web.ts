import { randomBytes } from 'node:crypto';
import path from 'node:path';
import webpack from 'webpack';
import { defaultProjectsDirectory } from '../src/studio';
import { startWebServer } from '../src/web/server';
import { webConfig } from '../webpack.web.config';

// Builds the renderer for the browser, rebuilds it on change, and serves it
// with the studio backend on 127.0.0.1.
//   GLIST_STUDIO_PORT      port to listen on (8787)
//   GLIST_STUDIO_PROJECTS  folder for new projects and the default to open
//   GLIST_STUDIO_TOKEN     access token (random per run)

const port = Number(process.env.GLIST_STUDIO_PORT ?? 8787);
const token = process.env.GLIST_STUDIO_TOKEN ?? randomBytes(18).toString('base64url');
const projectsDirectory = path.resolve(process.env.GLIST_STUDIO_PROJECTS ?? defaultProjectsDirectory());

webpack(webConfig).watch({}, (error, stats) => {
  if (error) console.error(error);
  else if (stats?.hasErrors() || stats?.hasWarnings()) console.log(stats.toString('errors-warnings'));
  else console.log(`Web bundle built in ${(stats?.endTime ?? 0) - (stats?.startTime ?? 0)} ms.`);
});

startWebServer({
  port,
  staticRoot: path.resolve(webConfig.output?.path ?? 'out/web'),
  templateRoot: path.resolve('glistapp-template'),
  projectsDirectory,
  token,
}).then(() => {
  console.log(`Glist Studio: http://127.0.0.1:${port}/?token=${token}`);
}, (error: Error) => {
  console.error(`Could not start the server: ${error.message}`);
  process.exit(1);
});
