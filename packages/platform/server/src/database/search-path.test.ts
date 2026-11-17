import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ProbeFoundation, probeFoundation } from '../authentication/probe-application.js'
import { probeSyncMade } from '../sync/probe-sync.js'
import { Database } from './database.js'
import { newId } from './identifier.js'

/**
 * Where the functions of the foundation look for what they use
 * (opengewerk#975). Left out of `search_path`, the temporary schema of a
 * session is searched first for tables and types, before pg_catalog, and every
 * role may make a temporary table or a type there. A function that runs as the
 * owner of the tables would then take a type the application made, and a check
 * on that type would run with the owner's rights. Listed last, it is searched
 * last, and never for a function or an operator.
 */

const north = { id: newId<'tenant'>(), name: 'Mandant Nord' }

let foundation: ProbeFoundation
let admin: Pool

beforeAll(async () => {
  foundation = await probeFoundation(probeSyncMade)
  admin = await foundation.kit.connect()
  await foundation.empty()
  await foundation.tenants(admin, [north])
}, 60_000)

afterAll(async () => {
  await admin.end()
  foundation.remove()
})

describe('the search path of the functions of the foundation', () => {
  it('is set by every function of the foundation, and ends with the temporary schema', async () => {
    const { rows } = await admin.query<{ signature: string; path: string | null }>(
      `select p.oid::regprocedure::text as signature,
              (select substr(s, length('search_path=') + 1) from unnest(p.proconfig) s
                where s like 'search_path=%') as path
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and not exists (select 1 from pg_depend d
                           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        order by 1`,
    )

    expect(rows.length).toBeGreaterThan(30)
    expect(rows.filter((row) => row.path === null || !/(^|,\s*)pg_temp$/.test(row.path))).toEqual(
      [],
    )
  })

  it('sets one for every function that runs as the owner of the tables', async () => {
    const { rows } = await admin.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and not exists (select 1 from unnest(p.proconfig) s where s like 'search_path=%')
        order by 1`,
    )

    expect(rows).toEqual([])
  })

  it('takes no type the application made in its session for one of the log', async () => {
    // A fresh connection, so that the log compiles its function in this
    // session, after the type is there.
    const database = Database.connect(foundation.kit.applicationDatabaseUrl())

    try {
      const ranAs = await database.forTenant(
        { tenantId: north.id, reason: 'probe.write' },
        async (tx) => {
          await tx.execute(sql`
            create function pg_temp.marker(v pg_catalog.jsonb) returns boolean
              language sql as $$ select pg_catalog.set_config('probe.ran_as', current_user, true) is not null $$`)
          await tx.execute(
            sql`create domain pg_temp.jsonb as pg_catalog.jsonb check (pg_temp.marker(value))`,
          )
          await tx.execute(sql`
            insert into shelves (tenant_id, label) values (${north.id}::uuid, 'Regal')`)

          const { rows } = await tx.execute<{ who: string | null }>(
            sql`select current_setting('probe.ran_as', true) as who`,
          )

          return rows[0]?.who ?? null
        },
      )

      expect(ranAs).toBeFalsy()
    } finally {
      await database.close()
    }
  })
})
