// A sound's sample rate and channels, as its file says, for the facts under
// its tab. The browser cannot tell them: decodeAudioData hands back the sound
// at the rate of the context it decoded in, never the file's. Read from the
// headers of WAV, FLAC, Ogg (Vorbis, Opus), MP3, AAC (ADTS) and MP4/M4A
// files; anything else, or a file that does not read as its kind, tells nothing.

export interface AudioFacts {
  sampleRate?: number;
  channels?: number;
  // What an Ogg file holds, which its extension does not say.
  codec?: string;
}

// Bytes of the file from offset, fewer at its end.
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>;

const text = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// How much of a file is looked through for an MP3 or AAC frame, and the most
// of an MP4's moov box read.
const scanBytes = 64 * 1024;
const moovBytes = 32 * 1024 * 1024;

const wav = async (read: ReadBytes, size: number): Promise<AudioFacts> => {
  for (let at = 12; at + 8 <= size;) {
    const header = await read(at, 24);
    if (header.length < 8) break;
    const length = view(header).getUint32(4, true);
    if (text(header, 0, 4) === 'fmt ' && header.length >= 16) {
      return { channels: view(header).getUint16(10, true), sampleRate: view(header).getUint32(12, true) };
    }
    // Chunks are padded to an even length.
    at += 8 + length + (length % 2);
  }
  return {};
};

// STREAMINFO, the first metadata block: 20 bits of sample rate, then 3 of channels less one.
const streamInfo = (bytes: Uint8Array, at: number): AudioFacts => (bytes.length < at + 13 ? {} : {
  sampleRate: (bytes[at + 10] << 12) | (bytes[at + 11] << 4) | (bytes[at + 12] >> 4),
  channels: ((bytes[at + 12] >> 1) & 7) + 1,
});

// The first page's first packet says what the stream is.
const ogg = async (read: ReadBytes): Promise<AudioFacts> => {
  const page = await read(0, 512);
  if (page.length < 28) return {};
  const packet = 27 + page[26];
  if (text(page, packet, 7) === '\x01vorbis' && page.length >= packet + 16) {
    return { codec: 'Vorbis', channels: page[packet + 11], sampleRate: view(page).getUint32(packet + 12, true) };
  }
  // Opus always plays at 48 kHz, whatever rate it was made from.
  if (text(page, packet, 8) === 'OpusHead' && page.length >= packet + 10) return { codec: 'Opus', channels: page[packet + 9], sampleRate: 48000 };
  if (text(page, packet, 5) === '\x7fFLAC') return { codec: 'FLAC', ...streamInfo(page, packet + 17) };
  return {};
};

const mpegRates = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];
const adtsRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// The first MP3 or AAC frame header in what was read: eleven or twelve bits
// set, then the version, layer, rate and channels.
const frames = (bytes: Uint8Array, from: number): AudioFacts => {
  for (let at = from; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[at + 1] >> 3) & 3;
    const layer = (bytes[at + 1] >> 1) & 3;
    if (layer === 0 && version >= 2) {
      const rate = adtsRates[(bytes[at + 2] >> 2) & 15];
      const channels = ((bytes[at + 2] & 1) << 2) | (bytes[at + 3] >> 6);
      if (rate && channels) return { sampleRate: rate, channels };
      continue;
    }
    const bitrate = bytes[at + 2] >> 4;
    const rate = mpegRates[version][(bytes[at + 2] >> 2) & 3];
    if (layer === 0 || version === 1 || bitrate === 0 || bitrate === 15 || !rate) continue;
    return { sampleRate: rate, channels: bytes[at + 3] >> 6 === 3 ? 1 : 2 };
  }
  return {};
};

// MP4's boxes: a size and a name, the size 1 for a 64-bit size after the
// name, 0 for the rest of the file.
interface Box { type: string; start: number; body: number; end: number }
const boxAt = (bytes: Uint8Array, at: number, limit: number): Box | null => {
  if (at + 8 > limit || at + 8 > bytes.length) return null;
  const small = view(bytes).getUint32(at);
  const large = small === 1 && at + 16 <= bytes.length ? Number(view(bytes).getBigUint64(at + 8)) : 0;
  const length = small === 1 ? large : small === 0 ? limit - at : small;
  if (length < 8) return null;
  return { type: text(bytes, at + 4, 4), start: at, body: at + (small === 1 ? 16 : 8), end: Math.min(at + length, limit) };
};
const child = (bytes: Uint8Array, parent: { body: number; end: number }, type: string): Box | null => {
  for (let at = parent.body; ;) {
    const box = boxAt(bytes, at, parent.end);
    if (!box) return null;
    if (box.type === type) return box;
    at = box.end;
  }
};

// The moov box, found by its header wherever it is: before or after the
// media data, which can be most of the file.
const mp4 = async (read: ReadBytes, size: number): Promise<AudioFacts> => {
  let moov: Uint8Array | null = null;
  for (let at = 0; at + 8 <= size;) {
    const header = await read(at, 16);
    const box = boxAt(header, 0, size - at);
    if (!box) break;
    if (box.type === 'moov') {
      if (box.end - box.start > moovBytes) return {};
      moov = await read(at, box.end - box.start);
      break;
    }
    at += box.end - box.start;
  }
  if (!moov) return {};
  const root = boxAt(moov, 0, moov.length);
  if (!root) return {};
  // The first track whose handler says sound: trak > mdia > hdlr, mdhd, minf > stbl > stsd.
  for (let at = root.body; ;) {
    const trak = boxAt(moov, at, root.end);
    if (!trak) return {};
    at = trak.end;
    if (trak.type !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!mdia || !hdlr || text(moov, hdlr.body + 8, 4) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const timescale = mdhd ? view(moov).getUint32(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12)) : 0;
    const stbl = child(moov, child(moov, mdia, 'minf') ?? { body: 0, end: 0 }, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    // The sample entry: after stsd's version and count, its own header, 8
    // bytes reserved, then channels, and later the rate in 16.16.
    const entry = stsd && boxAt(moov, stsd.body + 8, stsd.end);
    if (!entry || entry.body + 28 > moov.length) return timescale ? { sampleRate: timescale } : {};
    const rate = view(moov).getUint16(entry.body + 24);
    return { channels: aacChannels(moov, entry) ?? view(moov).getUint16(entry.body + 16), sampleRate: rate || timescale || undefined };
  }
};

// AAC's own count of channels, which the sample entry often leaves at two: in
// its esds box, the decoder's config (descriptor 5), after 5 bits of object
// type and 4 of rate (24 more for a rate given as a number).
const aacChannels = (bytes: Uint8Array, entry: Box): number | undefined => {
  if (entry.type !== 'mp4a') return undefined;
  // QuickTime's sound descriptions 1 and 2 are 16 and 36 bytes longer.
  const version = view(bytes).getUint16(entry.body + 8);
  const esds = child(bytes, { body: entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), end: entry.end }, 'esds');
  if (!esds) return undefined;
  // Descriptors: a tag, a length of 7 bits a byte, then what they hold; 3 and 4 hold others.
  for (let at = esds.body + 4; at < esds.end;) {
    const tag = bytes[at];
    let length = 0;
    let next = at + 1;
    for (let more = true; more && next < esds.end; next += 1) {
      length = (length << 7) | (bytes[next] & 0x7f);
      more = (bytes[next] & 0x80) !== 0;
    }
    if (tag === 5) {
      const bit = (index: number): number => ((bytes[next + (index >> 3)] ?? 0) >> (7 - (index & 7))) & 1;
      const take = (from: number, count: number): number => Array.from({ length: count }, (_, index) => bit(from + index))
        .reduce((value, one) => value * 2 + one, 0);
      const skip = 5 + (take(0, 5) === 31 ? 6 : 0);
      const channel = take(skip + 4 + (take(skip, 4) === 15 ? 24 : 0), 4);
      return channel >= 1 && channel <= 6 ? channel : channel === 7 ? 8 : undefined;
    }
    // ES (3): an id and flags; decoder config (4): 13 bytes of codec and rates.
    at = tag === 3 ? next + 3 + ((bytes[next + 2] & 0x80) ? 2 : 0) : tag === 4 ? next + 13 : next + length;
  }
  return undefined;
};

export const audioFacts = async (read: ReadBytes, size: number): Promise<AudioFacts> => {
  const head = await read(0, 16);
  const kind = text(head, 0, 4);
  if (kind === 'RIFF' && text(head, 8, 4) === 'WAVE') return wav(read, size);
  if (kind === 'OggS') return ogg(read);
  if (text(head, 4, 4) === 'ftyp') return mp4(read, size);
  // An ID3 tag before an MP3's frames, or sometimes before FLAC or AAC: ten
  // bytes, then its size in seven bits a byte, and ten more if it has a footer.
  let start = 0;
  if (text(head, 0, 3) === 'ID3' && head.length >= 10) {
    start = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0);
  }
  const bytes = await read(start, scanBytes);
  if (text(bytes, 0, 4) === 'fLaC') return streamInfo(bytes, 8);
  return frames(bytes, 0);
};
