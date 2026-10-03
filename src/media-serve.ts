import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fs, type ReadStream } from 'node:fs';
import path from 'node:path';
import { audioFacts, type AudioFacts } from './media-info';
import { mediaIdPattern, mediaReply, type MediaSource } from './media';

// Videos and sounds are streamed to their tabs from where they are, never sent
// whole as images are: a video can be hundreds of megabytes, and a player
// seeks by asking for byte ranges. A window asks for a file; the backend
// checks it may be read (studio.ts openMedia) and the main process, or the
// browser build's server, hands the window a name for it, random and its own,
// and serves only names it handed out (media-protocol.ts, web/server.ts). A
// name is forgotten when its tab closes or its window goes, and what was
// still being read from the file then is stopped, so nothing holds it open.

interface Grant<Owner> {
  owner: Owner;
  path: string;
  type: string;
  // What is reading the file for it right now.
  streams: Set<ReadStream>;
}

export interface MediaAnswer {
  status: 200 | 206 | 404 | 416;
  headers: Record<string, string>;
  body?: ReadStream;
}

export class MediaGrants<Owner> {
  private grants = new Map<string, Grant<Owner>>();

  grant(owner: Owner, source: { path: string; type: string }): string {
    const id = randomBytes(16).toString('hex');
    this.grants.set(id, { owner, path: source.path, type: source.type, streams: new Set() });
    return id;
  }

  owns(id: string, owner: Owner): boolean {
    return this.grants.get(id)?.owner === owner;
  }

  get size(): number {
    return this.grants.size;
  }

  // Only the window that was given a name lets go of it.
  release(owner: Owner, id: string | null): void {
    const grant = id ? this.grants.get(id) : undefined;
    if (!grant || grant.owner !== owner) return;
    this.grants.delete(id as string);
    grant.streams.forEach((stream) => stream.destroy());
  }

  releaseOwner(owner: Owner): void {
    [...this.grants.entries()].filter(([, grant]) => grant.owner === owner).forEach(([id]) => this.release(owner, id));
  }

  // The answer to a request for a name: the file, or the range of it asked
  // for, read as it is now; not found for a name not handed out or a file gone.
  async open(id: string, rangeHeader?: string | null, method = 'GET'): Promise<MediaAnswer> {
    const grant = mediaIdPattern.test(id) ? this.grants.get(id) : undefined;
    const stats = grant ? await fs.stat(grant.path).catch((): null => null) : null;
    if (!grant || !stats?.isFile()) return { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } };
    const reply = mediaReply(stats.size, grant.type, rangeHeader);
    if (!reply.range || method === 'HEAD') return { status: reply.status, headers: reply.headers };
    const body = createReadStream(grant.path, { start: reply.range.start, end: reply.range.end });
    grant.streams.add(body);
    body.once('close', () => grant.streams.delete(body));
    // A file gone between the look and the read fails the reply, not the process.
    body.on('error', () => undefined);
    return { status: reply.status, headers: reply.headers, body };
  }
}

// The window's name for a file, in place of where it is.
export const mediaFile = (source: MediaSource, base: string, id: string): GlistMediaFile => {
  const { path: filePath, ...facts } = source;
  return { ...facts, url: `${base}/${id}/${encodeURIComponent(path.basename(filePath))}` };
};

// A sound's rate and channels from its headers, reading only those.
export const readAudioFacts = async (filePath: string, size: number): Promise<AudioFacts> => {
  const handle = await fs.open(filePath, 'r');
  try {
    return await audioFacts(async (offset, length) => {
      const want = Math.max(0, Math.min(length, size - offset));
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(want), 0, want, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
  } catch {
    return {};
  } finally {
    await handle.close();
  }
};
