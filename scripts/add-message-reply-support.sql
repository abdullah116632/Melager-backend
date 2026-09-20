-- Swipe-to-reply: a message may quote an earlier one from the same mess.
-- The quote is resolved by join at read time, so editing the original keeps
-- every reply's quote accurate. Deleting it only drops the quote, never the
-- reply, hence ON DELETE SET NULL.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id integer
  REFERENCES messages(id) ON DELETE SET NULL;
