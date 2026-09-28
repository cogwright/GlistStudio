// eslint-disable-next-line import/no-unresolved
import { Uri } from 'monaco-editor/editor/editor.api';
import { getHostPlatform } from './host';

// Paths on the host, as seen by the renderer. The host can run another OS than
// the browser showing it, so nothing here asks the browser for its platform.

const windowsPath = /^([a-zA-Z]:[\\/]|\\\\)/;

export const baseName = (hostPath: string): string => hostPath.split(/[\\/]/).pop() ?? hostPath;

export const joinPath = (directory: string, name: string): string =>
  `${directory}${windowsPath.test(directory) ? '\\' : '/'}${name}`;

export const pathUri = (hostPath: string): Uri =>
  Uri.file(windowsPath.test(hostPath) ? hostPath.replace(/\\/g, '/') : hostPath);

export const uriPath = (uri: Uri): string => {
  if (/^\/[a-zA-Z]:\//.test(uri.path)) return uri.path.slice(1).replace(/\//g, '\\');
  if (uri.authority) return `\\\\${uri.authority}${uri.path.replace(/\//g, '\\')}`;
  return uri.path;
};

// Whether hostPath is entryPath or inside it. Only Linux file systems usually
// tell case apart.
export const isWithin = (hostPath: string, entryPath: string): boolean => {
  const normalize = (value: string): string => {
    const slashes = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return getHostPlatform() === 'linux' ? slashes : slashes.toLowerCase();
  };
  const candidate = normalize(hostPath);
  const entry = normalize(entryPath);
  return candidate === entry || candidate.startsWith(`${entry}/`);
};
