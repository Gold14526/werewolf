CREATE TABLE `moonwolf_entities` (
	`kind` text NOT NULL,
	`entity_key` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`kind`, `entity_key`)
);
--> statement-breakpoint
CREATE TABLE `moonwolf_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`nonce` text DEFAULT '' NOT NULL,
	CONSTRAINT "moonwolf_meta_singleton" CHECK("moonwolf_meta"."id" = 1)
);
