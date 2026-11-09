/**
 * The printer (Windows queue) name rule, shared by the printer form, bulk import, rename and the CLI: 1-100
 * characters, none of \ / , ! (Windows reserves them in queue names) and, since 0.8.1, no double quote and no control
 * characters. Agents pass the queue name to Windows tools (printui) whose command line splits on quotes, so a quote in
 * a name could add arguments (review L1); control characters (newlines) break logs and comments. Names stored before
 * 0.8.1 are fixed by migration 0008_printer_name_quotes.
 */
export const PRINTER_NAME_RE = /^[^\\/,!"\x00-\x1f\x7f]+$/;

export const PRINTER_NAME_RULE = 'Name cannot contain \\ / , ! " or control characters';
