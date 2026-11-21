-- The function initializes these tables automatically under an advisory lock.
-- Do not drop them during deploys: they contain identities and private games.
CREATE TABLE IF NOT EXISTS moonwolf_pg_meta (
  id smallint PRIMARY KEY CHECK (id = 1),
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_seen_ms bigint NOT NULL DEFAULT 0 CHECK (last_seen_ms >= 0)
);

CREATE TABLE IF NOT EXISTS moonwolf_pg_entities (
  kind text NOT NULL CHECK (kind IN ('sessions', 'rooms', 'histories', 'standings', 'limits')),
  entity_key text NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (kind, entity_key)
);

-- The function inserts the initial metadata row only when the entity table is
-- empty. A missing metadata row beside saved entities is rejected as corruption.
