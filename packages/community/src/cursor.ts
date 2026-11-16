const cursorPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z),([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** Keyset position over `(created_at, id)`: empty values start at the oldest row, undefined means malformed. */
export function parseCursor(value: string): [createdAt: string, id: string] | undefined {
  if (!value) return ['', ''];
  const match = cursorPattern.exec(value);
  return match ? [match[1]!, match[2]!] : undefined;
}

export const cursorAfter = (row: { created_at: string; id: string }) => `${row.created_at},${row.id}`;
