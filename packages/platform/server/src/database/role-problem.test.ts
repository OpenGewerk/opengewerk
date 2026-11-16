import { rmSync } from 'node:fs'

import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Database } from './database.js'
import { probeDatabase, probeMigrations } from './probe-database.js'
import { migrationRole } from './roles.js'

// Whether a role may run an application is what it is and not what it is
// called (opengewerk/opengewerk#685): every role here has a name of its own,
// and only what it can do decides.

const emptyFolder = probeMigrations([])
const kit = probeDatabase(emptyFolder)
const password = 'role-problem-685'
const roles = {
  plain: 'role_problem_plain',
  superuser: 'role_problem_superuser',
  bypass: 'role_problem_bypass',
  member: 'role_problem_member',
  owner: 'role_problem_owner',
  lender: 'role_problem_lender',
} as const

let pool: Pool

function urlOf(role: string): string {
  const url = new URL(kit.testDatabaseUrl())
  url.username = role
  url.password = password

  return url.toString()
}

async function problemOf(role: string): Promise<string | null> {
  const database = Database.connect(urlOf(role))

  try {
    return await database.roleProblem()
  } finally {
    await database.close()
  }
}

/** Roles live in the cluster and outlast the schema, so they go by hand. */
async function dropRoles(): Promise<void> {
  await pool.query('drop table if exists public.role_problem_probe')
  await pool.query('drop function if exists public.role_problem_planted()')

  for (const role of Object.values(roles)) {
    await pool.query(`drop role if exists "${role}"`)
  }
}

beforeAll(async () => {
  pool = await kit.connect()
  await kit.resetSchema(pool)
  await dropRoles()

  await pool.query(`create role "${roles.plain}" login password '${password}'`)
  await pool.query(`create role "${roles.superuser}" login superuser password '${password}'`)
  await pool.query(`create role "${roles.bypass}" login bypassrls password '${password}'`)
  await pool.query(
    `create role "${roles.member}" login password '${password}' in role "${migrationRole}"`,
  )
  await pool.query(`create role "${roles.owner}" login password '${password}'`)
  await pool.query(`create role "${roles.lender}" nologin`)
  await pool.query('create table public.role_problem_probe (id integer)')
  await pool.query(`alter table public.role_problem_probe owner to "${roles.owner}"`)
})

afterAll(async () => {
  await dropRoles()
  await kit.resetSchema(pool)
  await pool.end()
  rmSync(emptyFolder, { recursive: true, force: true })
})

describe('the role an application connects as (#685)', () => {
  it('may run it when it is none of the four, whatever it is called', async () => {
    expect(await problemOf(roles.plain)).toBeNull()
  })

  it('is refused as a superuser, whatever it is called', async () => {
    expect(await problemOf(roles.superuser)).toContain(
      `"${roles.superuser}", und diese Rolle ist Superuser`,
    )
  })

  it('is refused with BYPASSRLS', async () => {
    expect(await problemOf(roles.bypass)).toContain(
      `"${roles.bypass}", und diese Rolle hat BYPASSRLS`,
    )
  })

  it('is refused as a member of the owner of the tables', async () => {
    expect(await problemOf(roles.member)).toContain(`ist Mitglied von "${migrationRole}"`)
  })

  it('is refused when it owns a table', async () => {
    expect(await problemOf(roles.owner)).toContain('diese Rolle besitzt Tabellen der Datenbank')
  })

  it('is refused when every role may create in public, as in a cluster from before PostgreSQL 15', async () => {
    // What the owner's functions find there would run with the owner's rights
    // (opengewerk#975).
    await pool.query('grant create on schema public to public')

    try {
      expect(await problemOf(roles.plain)).toContain(
        `"${roles.plain}", und diese Rolle darf im Schema "public" anlegen`,
      )
    } finally {
      await pool.query('revoke create on schema public from public')
    }

    expect(await problemOf(roles.plain)).toBeNull()
  })

  it('is refused when it owns a function in public, made while it still could', async () => {
    // Taking the right back leaves what was made with it, and the owner's
    // functions would still find it (opengewerk#975).
    await pool.query(
      "create function public.role_problem_planted() returns integer language sql as 'select 1'",
    )
    await pool.query(`alter function public.role_problem_planted() owner to "${roles.plain}"`)

    try {
      expect(await problemOf(roles.plain)).toContain(
        `"${roles.plain}", und dieser Rolle gehören Funktionen, Operatoren oder Typen`,
      )
    } finally {
      await pool.query('drop function public.role_problem_planted()')
    }

    expect(await problemOf(roles.plain)).toBeNull()
  })

  it('is refused when a role it belongs to owns a function in public', async () => {
    // A member may do with an object what its owner may (CodeRabbit on
    // opengewerk#975).
    await pool.query(
      "create function public.role_problem_planted() returns integer language sql as 'select 1'",
    )
    await pool.query(`alter function public.role_problem_planted() owner to "${roles.lender}"`)
    await pool.query(`grant "${roles.lender}" to "${roles.plain}"`)

    try {
      expect(await problemOf(roles.plain)).toContain(
        `"${roles.plain}", und dieser Rolle gehören Funktionen, Operatoren oder Typen`,
      )
    } finally {
      await pool.query(`revoke "${roles.lender}" from "${roles.plain}"`)
      await pool.query('drop function public.role_problem_planted()')
    }

    expect(await problemOf(roles.plain)).toBeNull()
  })
})
