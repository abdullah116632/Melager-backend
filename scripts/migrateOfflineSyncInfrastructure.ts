import { pool } from "../db/dbConfig.js";

const client = await pool.connect();

try {
  await client.query("begin");
  await client.query(`
    create table if not exists sync_client_mutations (
      id bigserial primary key,
      client_mutation_id text not null,
      user_id integer not null references users(id) on delete cascade,
      mess_id integer references messes(id) on delete cascade,
      entity_type text not null,
      entity_id text not null,
      operation text not null check (
        operation in ('create', 'update', 'delete', 'upsert', 'command')
      ),
      request_hash text not null,
      response_status integer,
      response_body jsonb,
      completed_at timestamp,
      expires_at timestamp not null,
      created_at timestamp not null default now(),
      constraint sync_client_mutations_user_key_uq
        unique (user_id, client_mutation_id)
    )
  `);
  await client.query(`
    create index if not exists sync_client_mutations_mess_idx
      on sync_client_mutations (mess_id, id)
  `);
  await client.query(`
    create index if not exists sync_client_mutations_expiry_idx
      on sync_client_mutations (expires_at)
  `);
  await client.query(`
    create table if not exists sync_changes (
      id bigserial primary key,
      mess_id integer not null references messes(id) on delete cascade,
      actor_user_id integer references users(id) on delete set null,
      entity_type text not null,
      entity_id text not null,
      operation text not null check (
        operation in ('create', 'update', 'delete', 'upsert')
      ),
      payload jsonb not null,
      changed_at timestamp not null default now()
    )
  `);
  await client.query(`
    create index if not exists sync_changes_mess_cursor_idx
      on sync_changes (mess_id, id)
  `);
  await client.query("commit");
  console.log("Offline sync infrastructure migration applied.");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
