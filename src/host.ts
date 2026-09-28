// The platform of the machine running the backend, which the page showing it
// may not share. Reported once at startup; Windows until then.
let hostPlatform = 'win32';

export const setHostPlatform = (platform: string): void => { hostPlatform = platform; };
export const getHostPlatform = (): string => hostPlatform;
