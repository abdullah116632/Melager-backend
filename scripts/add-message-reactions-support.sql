-- One reaction per user per message. Changing a reaction replaces the old row,
-- removing it deletes the row, so counts are always a plain aggregate.
CREATE TABLE IF NOT EXISTS message_reactions (
  id serial PRIMARY KEY,
  message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_message_user_uq UNIQUE (message_id, user_id),
  CONSTRAINT message_reactions_reaction_check
    CHECK (reaction IN ('like', 'dislike', 'love', 'haha', 'sad', 'angry'))
);

CREATE INDEX IF NOT EXISTS message_reactions_message_idx
  ON message_reactions (message_id);
