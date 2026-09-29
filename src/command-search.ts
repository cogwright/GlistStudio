// Finding commands by what is typed: every word must appear, in any order,
// in the command's name or where it comes from. Accents do not matter, and a
// dotless i counts as i, so "calistir" finds "Çalıştır".

export interface Searchable {
  label: string;
  category: string;
  disabled?: boolean;
}

export const plainText = (text: string): string =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

// Names that start with what is typed first, then names with a word that does,
// then the rest; commands that can run now before those that cannot. Otherwise
// in the order given.
export const searchCommands = <T extends Searchable>(commands: T[], query: string): T[] => {
  const words = plainText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands.filter((command) => !command.disabled).concat(commands.filter((command) => command.disabled));
  const phrase = words.join(' ');
  return commands
    .map((command, index) => {
      const label = plainText(command.label);
      const text = `${label} ${plainText(command.category)}`;
      if (!words.every((word) => text.includes(word))) return null;
      const rank = label.startsWith(phrase) ? 0 : label.split(/[\s/.(-]+/).some((part) => part.startsWith(words[0])) ? 1 : 2;
      return { command, index, rank: rank + (command.disabled ? 3 : 0) };
    })
    .filter((entry): entry is { command: T; index: number; rank: number } => entry !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.command);
};
