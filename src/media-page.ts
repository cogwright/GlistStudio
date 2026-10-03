import { getLanguage, t } from './localization';
import { mediaType } from './media';

// A video or a sound in a tab of its own, played from where the file is: the
// window is given a URL for it as the tab is drawn and lets go of it when the
// tab closes (media-serve.ts), so a long video seeks without being read whole
// and nothing holds the file open afterwards, which Windows would not let be
// renamed or deleted. A video plays in the browser's own player; a sound has
// its waveform above the player, clicked to play from there. Both loop and
// change speed, pause while their tab is hidden, and Space plays and pauses
// them while the page has the keys. What the browser cannot play says so.

export interface MediaPage {
  name: string;
  // Read each time it is drawn: a renamed file's tab goes on with its new path.
  path: string;
  error?: string;
  // Where it was, whether it loops and how fast, kept while the tab is open,
  // for when it is drawn again.
  time?: number;
  loop?: boolean;
  rate?: number;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  made.className = className;
  if (text) made.textContent = text;
  return made;
};

const bytes = (size: number): string => {
  const [unit, value] = size >= 1024 * 1024 ? ['megabyte', size / 1024 / 1024] : size >= 1024 ? ['kilobyte', size / 1024] : ['byte', size];
  return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit, maximumFractionDigits: 1 }).format(value as number);
};

// Under a minute in seconds, as a sound effect is told; longer as 1:05 or 1:02:05.
const duration = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) {
    return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: seconds < 10 ? 2 : 1 }).format(seconds);
  }
  const whole = Math.round(seconds);
  const [hours, minutes, rest] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
};

const channelWords = (count: number): string => (count === 1 ? t('mediaMono') : count === 2 ? t('mediaStereo')
  : t('mediaChannels').replace('{count}', new Intl.NumberFormat(getLanguage()).format(count)));
const kilohertz = (rate: number): string => `${new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 1 }).format(rate / 1000)} kHz`;

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

// A sound is decoded whole to draw its waveform, at its own rate before it is
// brought down to the drawing's, so only one that decodes to at most this much
// is drawn: about 14 minutes of 44.1 kHz stereo. A longer one plays all the
// same, over a plain line that still shows where it is and seeks.
const decodedBytes = 300 * 1024 * 1024;
const fileBytes = 150 * 1024 * 1024;
// Frames a channel kept for the drawing, and the outline's columns.
const keptFrames = 4_000_000;
const peakColumns = 4096;

// The loudest sample in each column, of every channel together, drawn as
// high above the middle as below it.
const peaksOf = (buffer: AudioBuffer): Float32Array => {
  const count = Math.max(1, Math.min(peakColumns, buffer.length));
  const peaks = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  for (let column = 0; column < count; column += 1) {
    const from = Math.floor((column * buffer.length) / count);
    const to = Math.max(from + 1, Math.floor(((column + 1) * buffer.length) / count));
    let peak = 0;
    channels.forEach((data) => {
      for (let index = from; index < to; index += 1) peak = Math.max(peak, Math.abs(data[index]));
    });
    peaks[column] = peak;
  }
  return peaks;
};

export const renderMediaPage = (target: HTMLElement, page: MediaPage): { dispose(): void } => {
  const kind = mediaType(page.path)?.kind ?? 'audio';
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let url: string | null = null;
  let media: HTMLMediaElement | null = null;
  const facts = make('div', 'image-facts media-facts', t('mediaLoading'));
  target.replaceChildren(facts);
  const said = (text: string, factsText?: string): void => {
    const paragraph = make('p', 'readme-status media-status', text);
    facts.textContent = factsText ?? '';
    facts.hidden = !factsText;
    target.replaceChildren(paragraph, facts);
  };

  const play = (file: GlistMediaFile): void => {
    const element = document.createElement(kind);
    media = element;
    element.className = `media-${kind}`;
    element.controls = true;
    element.preload = 'metadata';
    element.loop = page.loop ?? false;
    element.defaultPlaybackRate = page.rate ?? 1;
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    const wrapper = make('div', `media-page ${kind}`);
    wrapper.tabIndex = 0;
    const stage = make('div', 'media-stage');
    const tools = make('div', 'media-tools');
    const loop = make('button', 'readme-github media-tool', t('mediaLoop'));
    loop.type = 'button';
    loop.setAttribute('aria-pressed', String(element.loop));
    loop.addEventListener('click', () => {
      element.loop = !element.loop;
      page.loop = element.loop;
      loop.setAttribute('aria-pressed', String(element.loop));
    });
    const speed = make('select', 'agent-select media-speed');
    speed.setAttribute('aria-label', t('mediaSpeed'));
    speed.title = t('mediaSpeed');
    const number = new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 2 });
    speed.replaceChildren(...speeds.map((value) => new Option(`${number.format(value)}×`, String(value), false, value === element.defaultPlaybackRate)));
    speed.addEventListener('change', () => {
      page.rate = Number(speed.value);
      element.defaultPlaybackRate = page.rate;
      element.playbackRate = page.rate;
    });
    tools.append(loop, speed);
    const format = file.codec && file.codec !== file.format ? `${file.format} ${file.codec}` : file.format;
    facts.textContent = `${format} · ${bytes(file.size)}`;
    const unplayable = (): void => {
      // Its side may show another page by now.
      if (disposed) return;
      element.removeAttribute('src');
      element.load();
      said(t(kind === 'video' ? 'mediaVideoUnplayable' : 'mediaAudioUnplayable'), facts.textContent ?? '');
    };
    element.addEventListener('error', unplayable);
    element.addEventListener('loadedmetadata', () => {
      // Chromium plays the sound of a video whose picture it cannot decode,
      // such as ProRes, and shows nothing: that is not a video playing.
      if (element instanceof HTMLVideoElement && element.videoWidth === 0) { unplayable(); return; }
      if (page.time && page.time < element.duration) element.currentTime = page.time;
      const parts = element instanceof HTMLVideoElement
        ? [format, `${element.videoWidth} × ${element.videoHeight}`, duration(element.duration), bytes(file.size)]
        : [format, duration(element.duration), file.sampleRate ? kilohertz(file.sampleRate) : '', file.channels ? channelWords(file.channels) : '', bytes(file.size)];
      facts.textContent = parts.filter(Boolean).join(' · ');
    });
    if (kind === 'audio') stage.append(waveform(element, file));
    stage.append(element, tools);
    wrapper.append(stage, facts);
    target.replaceChildren(wrapper);
    // Space plays and pauses; the player's own controls take it themselves.
    wrapper.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || event.target === element || (event.target instanceof Element && event.target.closest('button, input, select, textarea'))) return;
      event.preventDefault();
      if (element.paused) void element.play().catch((): undefined => undefined);
      else element.pause();
    });
    // Its tab hidden behind another, it stops.
    const hidden = new MutationObserver(() => { if (target.hidden) element.pause(); });
    hidden.observe(target, { attributes: true, attributeFilter: ['hidden'] });
    cleanups.push(() => hidden.disconnect());
    element.src = file.url;
    if (!target.hidden) wrapper.focus({ preventScroll: true });
  };

  // The waveform, drawn in the theme's colours, played part first, with the
  // place it is at; clicked or dragged along, it plays from there.
  const waveform = (element: HTMLMediaElement, file: GlistMediaFile): HTMLElement => {
    const wave = make('div', 'media-wave');
    const canvas = make('canvas', 'media-wave-canvas');
    const note = make('div', 'media-wave-note');
    note.hidden = true;
    wave.append(canvas, note);
    let peaks: Float32Array | null = null;
    let frame = 0;
    const draw = (): void => {
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0) return;
      const { width, height } = canvas;
      const style = getComputedStyle(wave);
      const played = style.getPropertyValue('--ui-accent').trim() || '#3794ff';
      const rest = style.getPropertyValue('--ui-fg-muted').trim() || '#888888';
      const pixel = Math.max(1, Math.round(window.devicePixelRatio || 1));
      const progress = element.duration > 0 ? Math.min(1, element.currentTime / element.duration) : 0;
      const split = Math.round(progress * width);
      const middle = height / 2;
      context.clearRect(0, 0, width, height);
      const columns = (from: number, to: number, color: string): void => {
        context.fillStyle = color;
        if (!peaks) { context.fillRect(from, middle - pixel / 2, to - from, pixel); return; }
        for (let x = from; x < to; x += 1) {
          const first = Math.floor((x * peaks.length) / width);
          const last = Math.max(first + 1, Math.floor(((x + 1) * peaks.length) / width));
          let peak = 0;
          for (let column = first; column < last; column += 1) peak = Math.max(peak, peaks[column]);
          const half = Math.min(1, peak) * middle * 0.95;
          context.fillRect(x, middle - half, 1, Math.max(pixel, half * 2));
        }
      };
      columns(0, split, played);
      columns(split, width, rest);
      context.fillStyle = style.getPropertyValue('--ui-fg').trim() || '#cccccc';
      context.fillRect(Math.min(width - pixel, Math.max(0, split - pixel / 2)), 0, pixel, height);
    };
    const animate = (): void => {
      draw();
      frame = !element.paused && !disposed ? requestAnimationFrame(animate) : 0;
    };
    element.addEventListener('play', () => { if (!frame) frame = requestAnimationFrame(animate); });
    ['pause', 'seeked', 'timeupdate', 'durationchange'].forEach((name) => element.addEventListener(name, () => { if (!frame) draw(); }));
    const resized = new ResizeObserver(() => {
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(wave.clientWidth * scale);
      canvas.height = Math.round(wave.clientHeight * scale);
      draw();
    });
    resized.observe(wave);
    // A theme chosen sets the page's colours on the root.
    const recoloured = new MutationObserver(draw);
    recoloured.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-kind'] });
    const seek = (event: PointerEvent): void => {
      const bounds = canvas.getBoundingClientRect();
      if (!(element.duration > 0) || bounds.width === 0) return;
      element.currentTime = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) * element.duration;
      draw();
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      seek(event);
    });
    canvas.addEventListener('pointermove', (event) => { if (canvas.hasPointerCapture(event.pointerId)) seek(event); });
    // Decoded once its length is known, away from the page's own work.
    const stop = new AbortController();
    element.addEventListener('loadedmetadata', async () => {
      const seconds = Number.isFinite(element.duration) ? element.duration : 0;
      if (file.size > fileBytes || seconds * (file.sampleRate ?? 48000) * (file.channels ?? 2) * 4 > decodedBytes) {
        note.textContent = t('mediaWaveTooLong');
        note.hidden = false;
        return;
      }
      try {
        const data = await (await fetch(file.url, { signal: stop.signal })).arrayBuffer();
        const rate = Math.max(3000, Math.min(file.sampleRate ?? 48000, 48000, Math.floor(keptFrames / Math.max(seconds, 1))));
        const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
        if (disposed) return;
        peaks = peaksOf(decoded);
        draw();
      } catch {
        if (disposed) return;
        note.textContent = t('mediaWaveFailed');
        note.hidden = false;
      }
    }, { once: true });
    cleanups.push(() => {
      stop.abort();
      cancelAnimationFrame(frame);
      resized.disconnect();
      recoloured.disconnect();
    });
    return wave;
  };

  if (page.error) { said(`${t('mediaFailed')}: ${page.error}`); return { dispose: (): undefined => undefined }; }
  window.glistAPI.openMedia(page.path).then((file) => {
    if (disposed) { void window.glistAPI.releaseMedia(file.url).catch((): undefined => undefined); return; }
    url = file.url;
    play(file);
  }).catch((error: unknown) => {
    if (disposed) return;
    const detail = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
    said(`${t('mediaFailed')}: ${detail}`);
  });

  return {
    dispose: () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      // Let go of the file before its name: the player's last request would
      // otherwise find the name gone and say so.
      if (media) {
        if (media.currentSrc) page.time = media.currentTime;
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
      if (url) void window.glistAPI.releaseMedia(url).catch((): undefined => undefined);
    },
  };
};
