// SQL the database tab writes itself, for the backend (database.ts) and the
// window (database-page.ts) alike.

export const quoteName = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// CREATE TABLE from the New Table form: a lone INTEGER primary key stays the
// rowid, as SQLite has it; several make one PRIMARY KEY together.
export interface NewColumn { name: string; type: string; primaryKey: boolean; notNull: boolean; unique: boolean; defaultValue: string }
export const createTableSql = (name: string, columns: NewColumn[]): string => {
  const named = columns.filter((column) => column.name.trim());
  const keys = named.filter((column) => column.primaryKey);
  const literal = (value: string): string => (/^(-?\d+(\.\d+)?|NULL|TRUE|FALSE|CURRENT_(TIME|DATE|TIMESTAMP))$/i.test(value.trim()) ? value.trim() : `'${value.replace(/'/g, "''")}'`);
  const lines = named.map((column) => [
    quoteName(column.name.trim()),
    column.type.trim(),
    keys.length === 1 && column.primaryKey ? 'PRIMARY KEY' : '',
    column.notNull ? 'NOT NULL' : '',
    column.unique ? 'UNIQUE' : '',
    column.defaultValue.trim() ? `DEFAULT ${literal(column.defaultValue)}` : '',
  ].filter(Boolean).join(' '));
  if (keys.length > 1) lines.push(`PRIMARY KEY (${keys.map((column) => quoteName(column.name.trim())).join(', ')})`);
  return `CREATE TABLE ${quoteName(name.trim())} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n);`;
};
