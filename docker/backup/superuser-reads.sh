# Reading the database of the application as postgres, for backup.sh,
# restore.sh, verify.sh and schedule.sh, which read this file with ".". It is
# not run on its own.
#
# The four read a few tables as postgres, the one role that sees the rows of
# every tenant through their policies. What those tables are, however, is
# decided by whatever wrote the database last, and after a restore that is the
# archive: it could leave a view in the place of a table, or a function or an
# operator in public that the query would find before the one it means. A
# superuser who reads such a view runs what the view calls, as superuser,
# beyond what the owner of the tables may do.
#
# So every read of a table goes through checked_query: one session and one
# transaction with a search path of pg_catalog alone, which first locks the
# table, then asks the catalogue that it is what the application made (a
# plain table in public, without tables under it, whose columns that are read
# have types of pg_catalog), and only then reads it. The lock is what makes
# the answer hold for the read: a table is renamed only with a lock that
# waits for this one, so nobody puts a view in its place in between, not even
# the owner at the same moment.

superuser_query() {
	PGOPTIONS='-c search_path=pg_catalog' psql --host "$POSTGRES_HOST" --username postgres \
		--dbname "$POSTGRES_DB" --tuples-only --no-align --quiet "$@"
}

# checked_query <table> "<column> ..." <select> [<option of psql> ...]
#
# Prints what the select returns, after the checks above held under the lock
# of the table. Where one does not hold, psql says why on stderr and ends with
# 3, and nothing is read. The table and the columns are the scripts' own,
# never read from an archive; the select is theirs as well.
checked_query() {
	checked_table="$1"
	checked_columns="$2"
	checked_select="$3"
	shift 3

	checked_list=''

	for checked_column in $checked_columns; do
		checked_list="${checked_list}${checked_list:+, }'${checked_column}'"
	done

	superuser_query -v ON_ERROR_STOP=1 "$@" <<SQL
begin;
lock table only public.${checked_table} in access share mode;
do \$checks\$
declare
	kind "char";
begin
	select c.relkind into kind from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relname = '${checked_table}';

	if kind is distinct from 'r' then
		raise exception 'public.${checked_table} ist keine gewöhnliche Tabelle (Art: "%"). So legt die Anwendung sie nicht an; die Datenbank wird nicht weiter gelesen.', coalesce(kind::text, '');
	end if;

	if exists (select 1 from pg_catalog.pg_inherits
		where inhparent = 'public.${checked_table}'::pg_catalog.regclass) then
		raise exception 'Unter public.${checked_table} hängen weitere Tabellen. So legt die Anwendung sie nicht an; die Datenbank wird nicht weiter gelesen.';
	end if;

	if exists (select 1 from pg_catalog.pg_attribute a
		join pg_catalog.pg_type t on t.oid = a.atttypid
		join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
		where a.attrelid = 'public.${checked_table}'::pg_catalog.regclass
		  and not a.attisdropped and a.attname = any (array[${checked_list}]::pg_catalog.text[])
		  and tn.nspname <> 'pg_catalog') then
		raise exception 'Eine gelesene Spalte von public.${checked_table} hat keinen Typ aus pg_catalog. Die Datenbank wird nicht weiter gelesen.';
	end if;
end
\$checks\$;
${checked_select};
commit;
SQL
}
