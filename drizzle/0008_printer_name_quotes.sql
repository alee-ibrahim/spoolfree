-- 0.8.1 (review L1): printer names may no longer contain a double quote or control characters (agents pass queue names
-- to Windows tools whose command line splits on quotes). Existing names that do are renamed in place: " becomes ',
-- control characters become a space. A clash with another printer's name gets a " (n)" suffix. The printer keeps its
-- id, so agents rename the queue at their next sync as for any rename, and each change is audit-logged.
DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, name FROM printers WHERE name ~ '["\x01-\x1f\x7f]' ORDER BY created_at, id LOOP
    base := btrim(regexp_replace(regexp_replace(replace(r.name, '"', ''''), '[\x01-\x1f\x7f]+', ' ', 'g'), '\s+', ' ', 'g'));
    IF base = '' THEN base := 'Printer'; END IF;
    base := left(base, 100);
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM printers WHERE lower(name) = lower(candidate) AND id <> r.id) LOOP
      n := n + 1;
      candidate := left(base, 94) || ' (' || n || ')';
    END LOOP;
    UPDATE printers SET name = candidate, updated_at = now() WHERE id = r.id;
    INSERT INTO audit_log (actor, action, entity_type, entity_id, details)
    VALUES ('migration', 'printer.update', 'printer', r.id::text,
      jsonb_build_object('before', jsonb_build_object('name', r.name), 'after', jsonb_build_object('name', candidate),
        'reason', 'printer names may not contain " or control characters (0.8.1)'));
  END LOOP;
END $$;
