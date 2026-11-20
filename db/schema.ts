import { sqliteTable, integer, text, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const meta = sqliteTable('moonwolf_meta', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  nonce: text('nonce').notNull().default(''),
}, (table) => [check('moonwolf_meta_singleton', sql`${table.id} = 1`)]);

export const entities = sqliteTable('moonwolf_entities', {
  kind: text('kind').notNull(),
  entityKey: text('entity_key').notNull(),
  data: text('data').notNull(),
}, (table) => [primaryKey({columns:[table.kind,table.entityKey]})]);
