-- The role the application connects as, and its way into the schema.
--
-- Row level security never applies to a superuser, and it applies to the owner
-- of a table only where the table says FORCE. The application therefore
-- connects as a role of its own that is neither: no superuser rights and no
-- ownership of any table. What it may do with a table is granted table by
-- table, further down in the migration this block is part of.
--
-- The role gets no password and no LOGIN here. Whoever sets the instance up
-- gives it both; credentials do not belong in a file that sits in every clone
-- of a repository.
--
-- Created only when it is missing: a role belongs to the cluster and not to
-- the database, so a second database on the same server finds it there.

DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opengewerk_app') THEN
		CREATE ROLE "opengewerk_app" NOLOGIN;
	END IF;
END
$$;--> statement-breakpoint
-- And no role but the owner creates in the schema (opengewerk#975). The
-- functions that run as the owner of the tables look there for what they call,
-- and what another role put there first would run with the owner's rights.
-- PostgreSQL 15 took the right from every role; a cluster upgraded from an
-- older version still grants it. Taking it back is not undone with the block.
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
-- For the same reason every function of the blocks names the temporary schema
-- last in its search path. Left out, it is searched first for tables and
-- types, before pg_catalog, and a type a role made there in its session, a
-- domain with a check of its own, say, would stand in for one a function of
-- the owner declares; the check would run with the owner's rights.
GRANT USAGE ON SCHEMA "public" TO "opengewerk_app";
