// Shortcuts follow the keyboard in front of the user, which can differ from the
// host's: Cmd on a Mac, Ctrl elsewhere.
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export const primaryKey = (event: KeyboardEvent): boolean => (isMac ? event.metaKey : event.ctrlKey);

export const shortcutLabel = (text: string): string => (isMac ? text.replace(/\bCtrl\b/g, 'Cmd') : text);
