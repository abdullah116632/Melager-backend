-- Chat file sharing. Only a description of the file is stored (name, type,
-- size, hash); the file itself never touches the server's disk or database.
-- It is relayed phone to phone over the realtime socket.
--
-- Nullable with no default, so it is a metadata-only change in PostgreSQL
-- (no table rewrite) and older backend builds, which never select or write
-- this column, keep working unchanged. Run this BEFORE deploying the backend
-- build that reads it.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment jsonb;
