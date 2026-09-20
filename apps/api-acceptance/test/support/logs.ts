/**
 * Reading the API's structured logs from outside the process.
 *
 * The API under test runs as a child process whose Pino logger writes one JSON
 * object per line to stdout, so the suite observes logs the way an operator
 * would: by parsing the stream. Anything that is not a JSON object — a stray
 * runtime warning, or the partial last line of a stream still being written —
 * is ignored rather than failing the read.
 *
 * @module
 */

export interface LogRecord {
  readonly [key: string]: unknown;
  readonly level?: string;
  readonly msg?: string;
}

/** Every parsable JSON line in `text`; non-JSON lines (and partial trailing lines) are ignored. */
export function parseLogRecords(text: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      // A partial line, or output that merely looks like JSON: not a record.
      continue;
    }
  }
  return records;
}
