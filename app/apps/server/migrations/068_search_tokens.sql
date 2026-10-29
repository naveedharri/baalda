-- Derived keyword sets for in-app search scoring (W3). Space-joined unique
-- `tokenize()` output of a note's title + body (note_index) or an extracted
-- file's text (blob_text), capped at 64 KB. NULL until the row is re-indexed;
-- search falls back to the old SQL count for a NULL row, so results never change.
ALTER TABLE note_index ADD COLUMN IF NOT EXISTS search_tokens text;
ALTER TABLE blob_text ADD COLUMN IF NOT EXISTS search_tokens text;
