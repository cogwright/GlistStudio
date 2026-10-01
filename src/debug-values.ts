// Values as the Variables view and the value popup show them. No Monaco or DOM,
// so it can be tested on its own.

// A pointer as an address without its leading zeros, nullptr when it is null,
// and an object the debugger only gives an address for as its type in braces,
// as {Player}, since its members say the rest. Anything else as given.
export const shownValue = (value: string, type = '', expandable = false): string => {
  const text = value.trim();
  const pointer = /\*\s*(?:const\s*)?$/.test(type.trim()) || type.trim() === 'std::nullptr_t';
  const address = /^0x0*([0-9a-f]+)\b(.*)$/i.exec(text);
  if (pointer && address) return address[1] === '0' ? `nullptr${address[2]}` : `0x${address[1]}${address[2]}`;
  if (expandable && type && /(?:^|\s)@\s*0x[0-9a-f]+$/i.test(text)) return `{${type.trim()}}`;
  return value;
};
