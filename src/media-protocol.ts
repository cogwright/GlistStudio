import { Readable } from 'node:stream';
import { protocol, session, type WebContents } from 'electron';
import { mediaFile, MediaGrants } from './media-serve';
import { mediaIdOf, type MediaSource } from './media';

// The app's videos and sounds come by glist-media://media/<name>/<file>, a
// scheme of its own served from this process (media-serve.ts says how names
// are given). Privileged before the app is ready: stream for players, fetch
// and CORS for reading a sound's bytes to draw its waveform from a page whose
// origin is another, secure and standard for a URL like any other. Electron 44
// seeked without stream too, but not without 206 answers to Range requests: an
// MP4 whose index is at its end did not play at all.
const scheme = 'glist-media';
export const registerMediaScheme = (): void => protocol.registerSchemesAsPrivileged([
  { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Names are each window's: given to its page, forgotten when it loads another
// page or goes.
const grants = new MediaGrants<number>();
const watched = new Set<number>();
const watch = (contents: WebContents): void => {
  const owner = contents.id;
  if (watched.has(owner)) return;
  watched.add(owner);
  contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => { if (isMainFrame && !isSameDocument) grants.releaseOwner(owner); });
  contents.once('destroyed', () => { grants.releaseOwner(owner); watched.delete(owner); });
};

export const grantMedia = (contents: WebContents, source: MediaSource): GlistMediaFile => {
  watch(contents);
  return mediaFile(source, `${scheme}://media`, grants.grant(contents.id, source));
};
export const releaseMedia = (contents: WebContents, url: unknown): void => grants.release(contents.id, mediaIdOf(url));

const idOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.host === 'media' ? mediaIdOf(parsed.pathname) : null;
  } catch {
    return null;
  }
};

export const serveMedia = (): void => {
  // A name only plays in the window it was given to. The app's only use of
  // webRequest: a session takes one onBeforeRequest listener.
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${scheme}://*/*`] }, (details, callback) => {
    const id = idOf(details.url);
    callback({ cancel: !id || details.webContentsId === undefined || !grants.owns(id, details.webContentsId) });
  });
  protocol.handle(scheme, async (request) => {
    const id = idOf(request.url);
    const answer = id ? await grants.open(id, request.headers.get('range'), request.method) : { status: 404, headers: {} };
    const body = 'body' in answer && answer.body ? Readable.toWeb(answer.body) as ReadableStream : null;
    return new Response(body, { status: answer.status, headers: answer.headers });
  });
};
