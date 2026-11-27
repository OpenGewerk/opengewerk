import { createHash } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  addDays,
  berlinClock,
  type IsoDate,
  shippedRules,
  sicknessErasureDueOn,
  sicknessErasureLabel,
  type TenantId,
} from '@opengewerk/domain'
import { Database, newId, removedAddress } from '@opengewerk/platform-server'
import { sql } from 'drizzle-orm'
import type { Pool, PoolClient } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applicationDatabaseUrl, connect, resetToMigrated } from '../database/test-database.js'
import { runDeadlinesOf } from '../deadlines/engine.js'
import { ErasureBusy } from '../privacy/erasure.js'
import { dueStaffYears, holdStaffYear, staffYearKey } from '../privacy/staff-erasure.js'
import { ApiModule } from './api.module.js'
import { type HeldQuery, holdQuery, waitingFor } from './test-hold.js'
import { testIdentities as identities } from './test-identity.js'

/**
 * The staff under the deletion concept (#846, decided on 04.11.2026): a
 * sickness a year after its last day, the time and leave of a year eight years
 * after its end, the file of somebody who left three years after the end of
 * that year, its name with the last year kept. What stays of the person is an
 * empty file and the key of the account the rest of the business points at.
 */

const north = newId<'tenant'>() as TenantId
const south = newId<'tenant'>() as TenantId

let admin: Pool
let database: Database
let app: INestApplication

function person(userId: string, roles: string[], tenantId: TenantId = north) {
  return JSON.stringify({ userId, tenantId, roles })
}

const owner = person('lena', ['owner'])
const office = person('bruno', ['office'])
const technician = person('kurt', ['technician'])

const today = berlinClock(new Date()).day
const thisYear = Number(today.slice(0, 4))
/** A year whose time and leave are due: eight years after its end have passed (#1019). */
// Its last record, a correction, was entered on New Year's Day after it, so
// the year counts from the end of the next (#1033), and is due.
const oldYear = thisYear - 10
/** The year after it, which is not due yet. */
const nextYear = oldYear + 1
/** The day the person left, three years and more before the start of this year. */
const leftOn = `${String(thisYear - 4)}-06-30`

function http() {
  return request(app.getHttpServer())
}

function refusal(answer: { body: unknown }): string {
  return String((answer.body as { message?: string }).message)
}

/** The message of whatever a statement of the application threw, the database's included. */
async function refusedWith(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause

    return String(cause?.message ?? (error as Error).message)
  }

  return 'went through'
}

/** A statement of the application role, in the business of the north as whoever leads it. */
function asApplication(statement: string) {
  return database.forTenant({ tenantId: north, userId: 'lena' }, (tx) =>
    tx.execute(sql.raw(statement)),
  )
}

interface Fixture {
  readonly family: string
  readonly person: string
  readonly certificate: string
  /** The certificate the qualification named before (opengewerk#802). */
  readonly earlierCertificate: string
  readonly dueSickness: string
  readonly freshSickness: string
  readonly oldSickness: string
  readonly vacation: string
  /** The last entry of the old year, and its correction made after New Year. */
  readonly lastEntry: string
  readonly correction: string
}

/**
 * Dennis Kraft, who left three years and more ago, with something in every
 * table a deletion of the staff reaches and the name of his family in each:
 * records of time, times on call, absences and days of leave of the old year
 * and the year after, a sickness that is due and one that is not, the
 * working time agreed, a qualification with its certificate and the one it
 * named before, an answer
 * about recording the place, and the account he signed in with.
 */
async function kraft(withLaterYears = true): Promise<Fixture> {
  const family = `Kraft${newId<'person'>().slice(-6)}`
  const id = newId<'person'>()
  const certificate = createHash('sha256').update(family).digest('hex')
  const earlierCertificate = createHash('sha256').update(`${family} vorher`).digest('hex')
  const dueSickness = newId<'absence'>()
  const freshSickness = newId<'absence'>()
  const oldSickness = newId<'absence'>()
  const vacation = newId<'absence'>()
  const lastEntry = newId<'time-entry'>()
  const correction = newId<'time-entry'>()
  const dueLast = addDays(today, -400)
  const freshLast = addDays(today, -100)
  const o = String(oldYear)
  const n = String(nextYear)
  // The year after was entered in January after its end, as the last days of
  // a year often are, and so it is not due yet although its own end is.
  const enteredAfter = `${String(nextYear + 1)}-01-15 09:00+01`

  await admin.query(
    `update auth_users set name = 'Dennis ${family}', email = 'dennis@${family.toLowerCase()}.example' where id = 'kurt';
     update memberships set last_day = '${leftOn}' where tenant_id = '${north}' and user_id = 'kurt';
     begin;
     set local app.user_id = 'kurt';
     insert into people (id, tenant_id, name, user_id, joined_on, left_on)
       values ('${id}', '${north}', 'Dennis ${family}', 'kurt', '${String(oldYear - 3)}-03-01', '${leftOn}');
     insert into working_times (tenant_id, person_id, valid_from, monday_minutes, tuesday_minutes)
       values ('${north}', '${id}', '${String(oldYear - 3)}-03-01', 480, 480);
     insert into files (tenant_id, sha256, size_bytes, media_type)
       values ('${north}', '${certificate}', 12, 'application/pdf'),
              ('${north}', '${earlierCertificate}', 12, 'application/pdf');
     insert into qualifications (tenant_id, person_id, kind_key, valid_until, note, certificate_sha256, certificate_name)
       values ('${north}', '${id}', 'electrician', '2030-01-01', 'Prüfung bei ${family}', '${earlierCertificate}', 'vorher-${family}.pdf');
     update qualifications set certificate_sha256 = '${certificate}', certificate_name = 'pruefung-${family}.pdf'
      where person_id = '${id}';
     insert into absences (id, tenant_id, person_id, kind, state, first_day, last_day, note, created_at)
       values ('${vacation}', '${north}', '${id}', 'vacation', 'approved', '${o}-08-01', '${o}-08-14', 'Urlaub der ${family}s', '${o}-06-02 09:00+02'),
              ('${oldSickness}', '${north}', '${id}', 'sickness', 'approved', '${o}-05-06', '${o}-05-10', null, '${o}-05-06 08:00+02');
     insert into leave_entitlements (tenant_id, person_id, year, entitled_half_days, carried_half_days, created_at)
       values ('${north}', '${id}', ${o}, 60, 4, '${o}-01-02 09:00+01');
     insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note, start_latitude_micro, start_longitude_micro, created_at)
       values ('${north}', 'kurt', 'work', '${o}-03-04 07:00+01', '${o}-03-04 15:30+01', 'Baustelle ${family}', 53550000, 9990000, '${o}-03-04 15:30+01');
     insert into time_entries (id, tenant_id, user_id, kind, started_at, ended_at, note, created_at)
       values ('${lastEntry}', '${north}', 'kurt', 'work', '${o}-12-31 22:00+01', '${o}-12-31 23:30+01', 'Silvester bei ${family}', '${o}-12-31 23:30+01');
     insert into time_entries (id, tenant_id, user_id, kind, started_at, ended_at, note, corrects_entry_id, created_at)
       values ('${correction}', '${north}', 'kurt', 'work', '${n}-01-01 00:10+01', '${n}-01-01 01:00+01', 'Silvester bei ${family}, berichtigt', '${lastEntry}', '${n}-01-01 01:00+01');
     insert into on_call_shifts (tenant_id, user_id, starts_at, ends_at, note, created_at)
       values ('${north}', 'kurt', '${o}-05-01 16:00+02', '${o}-05-08 07:00+02', 'Bereitschaft ${family}', '${o}-05-08 07:00+02');
     insert into location_consents (tenant_id, user_id, given) values ('${north}', 'kurt', true);
     ${
       withLaterYears
         ? `insert into absences (id, tenant_id, person_id, kind, state, first_day, last_day, note, created_at)
              values (gen_random_uuid(), '${north}', '${id}', 'vacation', 'approved', '${n}-07-01', '${n}-07-10', 'Urlaub der ${family}s', '${enteredAfter}'),
                     ('${dueSickness}', '${north}', '${id}', 'sickness', 'approved', '${addDays(dueLast, -4)}', '${dueLast}', null, default),
                     ('${freshSickness}', '${north}', '${id}', 'sickness', 'approved', '${addDays(freshLast, -4)}', '${freshLast}', null, default);
            insert into leave_entitlements (tenant_id, person_id, year, entitled_half_days, carried_half_days, created_at)
              values ('${north}', '${id}', ${n}, 60, 0, '${enteredAfter}');
            insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note, created_at)
              values ('${north}', 'kurt', 'work', '${n}-02-02 07:00+01', '${n}-02-02 15:00+01', 'Baustelle ${family}', '${enteredAfter}');
            insert into on_call_shifts (tenant_id, user_id, starts_at, ends_at, note, created_at)
              values ('${north}', 'kurt', '${n}-05-01 16:00+02', '${n}-05-08 07:00+02', 'Bereitschaft ${family}', '${enteredAfter}');`
         : ''
     }
     -- Last written when they were entered: the trigger stamps the moment of
     -- the insert, and what counts (#1033) is when they came to be.
     set local session_replication_role = replica;
     update absences set updated_at = created_at where person_id = '${id}';
     update leave_entitlements set updated_at = created_at where person_id = '${id}';
     update time_entries set updated_at = created_at where tenant_id = '${north}' and user_id = 'kurt';
     update on_call_shifts set updated_at = created_at where tenant_id = '${north}' and user_id = 'kurt';
     commit;`,
  )

  return {
    family,
    person: id,
    certificate,
    earlierCertificate,
    dueSickness,
    freshSickness,
    oldSickness,
    vacation,
    lastEntry,
    correction,
  }
}

/** Where the family name still stands, as table and column, in every text of the database. */
async function tracesOf(family: string): Promise<string[]> {
  const { rows } = await admin.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'jsonb', 'character varying')
        and table_name in (select tablename from pg_tables where schemaname = 'public')`,
  )
  const found: string[] = []

  for (const row of rows) {
    const hit = await admin.query(
      `select 1 from "${row.table_name}" where "${row.column_name}"::text ~* $1 limit 1`,
      [family],
    )

    if (hit.rowCount === 1) {
      found.push(`${row.table_name}.${row.column_name}`)
    }
  }

  return found.sort()
}

async function count(statement: string, values: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(statement, values)

  return Number(rows[0]?.n)
}

function erase(kind: string, ids: string[], who = owner) {
  return http().post('/privacy/erasures').set('x-test-identity', who).send({ kind, ids })
}

interface Due {
  kind: string
  recordId: string
  name: string
  detail: string
  dueOn: string
}

async function dueFor(who: string): Promise<Due[] | null> {
  const answer = await http().get('/privacy').set('x-test-identity', who).expect(200)

  return (answer.body as { due: Due[] | null }).due
}

async function pass() {
  await runDeadlinesOf({ database }, north, new Date())
}

/** A pass at night: the deadlines follow their sources, and nothing is done about them yet. */
async function nightPass() {
  await runDeadlinesOf({ database }, north, new Date(`${today}T01:00:00Z`))
}

/** A pass at noon, after the morning: what a deadline does is done. */
function noonPass() {
  return runDeadlinesOf({ database }, north, new Date(`${today}T10:00:00Z`))
}

/** Switches a kind of erasure to go by itself, in the name of whoever leads. */
async function byItself(kind: string) {
  await admin.query(
    `begin; set local app.user_id = 'lena';
     insert into erasure_automations (tenant_id, kind, created_by) values ('${north}', '${kind}', 'lena');
     commit;`,
  )
}

/** What a pass failed with, one reason per reminder. */
function reasonsOf(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors : [error]
}

/** The line of the protocol a deletion writes first, as drizzle sends it. */
const protocolLine = /^insert into "erasures"/i

/**
 * A transaction of the test's own, ended and given back whatever happened:
 * rolled back, which after a commit changes nothing, and the connection
 * thrown away when even that fails.
 */
async function ownTransaction<Result>(work: (client: PoolClient) => Promise<Result>) {
  const client = await admin.connect()
  let broken = false

  try {
    await client.query('begin')

    return await work(client)
  } finally {
    await client.query('rollback').catch(() => {
      broken = true
    })
    client.release(broken)
  }
}

/**
 * Settles once the statement is held, and fails with the answer of the
 * request when that ended first, so that a test does not wait for its time
 * to run out over an answer it never sees.
 */
async function reachedBefore(
  stopped: HeldQuery,
  asked: Promise<{ readonly status: number; readonly body: unknown }>,
): Promise<void> {
  const ended = asked.then((answer) => {
    throw new Error(
      `The request ended with ${String(answer.status)} before the held statement: ${JSON.stringify(answer.body)}`,
    )
  })

  ended.catch(() => undefined)

  await Promise.race([stopped.reached, ended])
}

/**
 * Waits until a statement waits for a lock, of the kind `event` names or any,
 * and where `statement` is given, one whose text has it.
 */
async function untilWaiting(
  holder: number,
  event?: string,
  statement?: string,
  stop?: () => boolean,
): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // Raced against work that may end first: then nobody waits for the
    // answer, and the watch ends with it rather than ask on into the next test.
    if (stop?.()) {
      return
    }

    // Only a statement that waits for `holder`: another session waiting for
    // the same kind of lock lets nothing go too early.
    const waiting =
      event === undefined
        ? await count(
            `select count(*) as n from pg_stat_activity
              where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
            [holder],
          )
        : await count(
            `select count(*) as n from pg_stat_activity
              where wait_event_type = 'Lock' and wait_event = $1 and query like $2
                and $3 = any(pg_blocking_pids(pid))`,
            [event, `%${statement ?? ''}%`, holder],
          )

    if (waiting > 0) {
      return
    }

    await new Promise((done) => setTimeout(done, 50))
  }

  throw new Error('Nothing came to wait for a lock')
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2), ($3, $4)', [
    north,
    'Elektro Nord GmbH',
    south,
    'Elektro Süd GmbH',
  ])
  await admin.query(
    `insert into tenant_roles (tenant_id, key, label, rights, leads, second_factor) values
       ($1, 'owner', 'Inhaber', '{}', true, false), ($1, 'office', 'Büro', '{}', false, false),
       ($1, 'technician', 'Monteur', '{}', false, false), ($2, 'owner', 'Inhaber', '{}', true, false)`,
    [north, south],
  )
  await admin.query(
    `insert into auth_users (id, name, email) values
       ('lena', 'Lena Leitung', 'lena@example.de'), ('bruno', 'Bruno Büro', 'bruno@example.de'),
       ('kurt', 'Dennis Kraft', 'dennis@example.de'), ('sven', 'Sven Süd', 'sven@example.de')`,
  )
  await admin.query(
    `insert into memberships (tenant_id, user_id, roles) values
       ($1, 'lena', '{owner}'), ($1, 'bruno', '{office}'), ($1, 'kurt', '{technician}'),
       ($2, 'sven', '{owner}')`,
    [north, south],
  )

  database = Database.connect(applicationDatabaseUrl())

  const built = await Test.createTestingModule({
    imports: [ApiModule.create(database, identities)],
  }).compile()

  app = built.createNestApplication()
  await app.init()
})

beforeEach(async () => {
  await admin.query(
    `begin; set local session_replication_role = replica;
     delete from audit_redactions; delete from erasures; delete from erasure_automations;
     delete from deadlines; delete from tasks; delete from time_entries; delete from on_call_shifts;
     delete from absences; delete from leave_entitlements; delete from location_consents;
     delete from replaced_certificates; delete from qualifications; delete from working_times;
     delete from people; delete from files;
     delete from document_snapshots; delete from documents; delete from customers;
     delete from article_imports; delete from suppliers;
     commit;`,
  )
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
})

describe('what of the staff is due (#846)', () => {
  it('is a sickness a year after its last day, a year eight years after its end and a file three years after leaving', async () => {
    const dennis = await kraft()

    await pass()

    const due = (await dueFor(owner)) ?? []

    expect(due.map((entry) => [entry.kind, entry.detail]).sort()).toEqual(
      [
        ['person', `Akte, Austritt 30.06.${String(thisYear - 4)}`],
        ['sickness', `Krankheit, letzter Tag ${germanDay(addDays(today, -400))}`],
        ['sickness', `Krankheit, letzter Tag 10.05.${String(oldYear)}`],
        ['staff_year', `Arbeitszeiten und Urlaub ${String(oldYear)}`],
      ].sort(),
    )
    expect(due.every((entry) => entry.name === `Dennis ${dennis.family}`)).toBe(true)
    expect(due.find((entry) => entry.kind === 'staff_year')?.recordId).toBe(
      staffYearKey(dennis.person, oldYear),
    )

    // The deadlines name nobody, and the key of a year is the database's as well.
    const { rows } = await admin.query<{ source_label: string; source_id: string }>(
      `select source_label, source_id::text from deadlines where kind like 'privacy.%'`,
    )

    expect(rows.every((row) => !row.source_label.includes(dennis.family))).toBe(true)
    expect(
      await count(`select count(*) as n from deadlines where source_id = staff_year_key($1, $2)`, [
        dennis.person,
        oldYear,
      ]),
    ).toBe(1)
  })

  it('keeps a year eight years after a correction to it was entered, also once it was found due (#1033)', async () => {
    const dennis = await kraft(false)

    await pass()

    // The correction of the last entry of the year, entered only this year,
    // after the pass had found the year due: deleting it is refused at once.
    await admin.query(
      `begin; set local session_replication_role = replica;
       update time_entries set created_at = now(), updated_at = now() where id = '${dennis.correction}'; commit;`,
    )
    await erase('staff_year', [staffYearKey(dennis.person, oldYear)]).expect(409)
    await pass()

    const due = (await dueFor(owner)) ?? []

    expect(due.filter((entry) => entry.kind === 'staff_year')).toEqual([])
    // Nor is a deadline open for it: a year has one only once it is due.
    expect(
      await count("select count(*) as n from deadlines where source_id = $1 and status = 'open'", [
        staffYearKey(dennis.person, oldYear),
      ]),
    ).toBe(0)
  })

  it('keeps a year eight years after its days of leave were corrected in their row (#1033)', async () => {
    const dennis = await kraft(false)
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    expect(((await dueFor(owner)) ?? []).map((entry) => entry.recordId)).toContain(key)

    // The office corrects the leave of the old year this year. The row of the
    // entitlement changes in place and keeps the day it was entered.
    await http()
      .put(`/absences/people/${dennis.person}/entitlements/${String(oldYear)}`)
      .set('x-test-identity', owner)
      .send({ entitledHalfDays: 58, carriedHalfDays: 4 })
      .expect(200)
    await erase('staff_year', [key]).expect(409)
    // And the next pass no longer proposes it.
    await pass()

    expect(((await dueFor(owner)) ?? []).map((entry) => entry.recordId)).not.toContain(key)
  })

  it('reads a year again before deleting it, and a correction since the list makes it not due (#1033)', async () => {
    const dennis = await kraft(false)
    const lena = { tenantId: north, userId: 'lena' }

    await pass()

    // What the deletion found due when it read the list.
    const [year] = await database.forTenant(lena, (tx) =>
      dueStaffYears(tx, today, [staffYearKey(dennis.person, oldYear)]),
    )

    if (year === undefined) {
      throw new Error('The old year of the fixture is due')
    }

    const before = await database.forTenant(lena, (tx) => holdStaffYear(tx, year, today))

    // Counted from the end of the year after, when the correction after New
    // Year was entered, and eight years on.
    expect(before?.dueOn).toBe(`${String(oldYear + 10)}-01-01`)
    expect(before?.entitlements).toHaveLength(1)

    // Corrected after that reading: held again, it is not due.
    await http()
      .put(`/absences/people/${dennis.person}/entitlements/${String(oldYear)}`)
      .set('x-test-identity', owner)
      .send({ entitledHalfDays: 58, carriedHalfDays: 4 })
      .expect(200)

    expect(await database.forTenant(lena, (tx) => holdStaffYear(tx, year, today))).toBeNull()
  })

  it('refuses a year that a correction made not due while the deletion waited for it (#1033)', async () => {
    const dennis = await kraft(false)

    await pass()

    await ownTransaction(async (client) => {
      // A correction of the days of leave of the old year, written and not
      // committed yet: the deletion reads the list without it, finds the year
      // due and waits at the row.
      await client.query(
        'update leave_entitlements set carried_half_days = 5 where person_id = $1 and year = $2',
        [dennis.person, oldYear],
      )

      const asked = erase('staff_year', [staffYearKey(dennis.person, oldYear)]).then(
        (answer) => answer,
      )

      await waitingFor(admin, client, asked)
      await client.query('commit')

      expect((await asked).status).toBe(409)
    })

    expect(
      await count('select count(*) as n from leave_entitlements where person_id = $1', [
        dennis.person,
      ]),
    ).toBe(1)
  })

  it('lets a record that comes into a year while it is deleted wait, and refuses it then (#1043)', async () => {
    const dennis = await kraft(false)
    const late = newId<'absence'>()
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [key]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    // An absence of the old year that comes in while the deletion runs. It
    // waits for the lock of the year the deletion took first, and once the
    // deletion is through it would be a record that could never go.
    const added = admin
      .query(
        `insert into absences (id, tenant_id, person_id, kind, state, first_day, last_day, note)
           values ($1, $2, $3, 'vacation', 'approved', $4, $5, 'nachgetragen')`,
        [late, north, dennis.person, `${String(oldYear)}-10-05`, `${String(oldYear)}-10-06`],
      )
      .then(
        () => 'went through',
        (error: unknown) => (error as Error).message,
      )

    await untilWaiting(stopped.holder(), 'advisory', 'insert into absences').finally(
      stopped.release,
    )

    expect((await asked).status).toBe(201)
    expect(await added).toBe(
      `Das Jahr ${String(oldYear)} dieser Person ist nach dem Löschkonzept gelöscht. ` +
        'Für dieses Jahr nimmt OpenGewerk nichts mehr an.',
    )
    expect(await count('select count(*) as n from absences where id = $1', [late])).toBe(0)
    expect(await count('select count(*) as n from erasures where record_id = $1', [key])).toBe(1)
  })

  it('keeps the file of somebody whose access opened again while the deletion read it (#1033)', async () => {
    const dennis = await kraft()

    await pass()

    expect(((await dueFor(owner)) ?? []).map((entry) => entry.recordId)).toContain(dennis.person)

    const stopped = holdQuery((statement) => /from memberships where user_id/i.test(statement))
    const asked = erase('person', [dennis.person]).then((answer) => answer)

    await reachedBefore(stopped, asked)
    // The access opened again after the list was read, and before the
    // deletion reads it again.
    await admin
      .query(`update memberships set last_day = null where tenant_id = $1 and user_id = 'kurt'`, [
        north,
      ])
      .finally(stopped.release)

    expect((await asked).status).toBe(409)
    expect(
      await count(`select count(*) as n from working_times where person_id = $1`, [dennis.person]),
    ).toBe(1)
  })

  /**
   * The account read with the list is the one whose devices, feeds and name
   * go with the file. Taken off the person between the list and the hold, it
   * is not deleted: the file changed (#1045).
   */
  it('keeps the file of somebody whose account changed while the deletion read it (#1033)', async () => {
    const dennis = await kraft()

    await pass()

    const stopped = holdQuery((statement) => /from memberships where user_id/i.test(statement))
    const asked = erase('person', [dennis.person]).then((answer) => answer)

    await reachedBefore(stopped, asked)
    await admin
      .query('update people set user_id = null where id = $1', [dennis.person])
      .finally(stopped.release)

    expect((await asked).status).toBe(409)
    expect(
      await count(`select count(*) as n from working_times where person_id = $1`, [dennis.person]),
    ).toBe(1)
  })

  it('holds the file, what of it a write can change and its access until the deletion is through (#1033)', async () => {
    const dennis = await kraft()
    const feed = createHash('sha256').update(`${dennis.family} Kalender`).digest('hex')

    await admin.query(
      `begin; set local app.user_id = 'kurt';
       insert into push_subscriptions (tenant_id, user_id, entry, label, endpoint, p256dh, auth)
         values ('${north}', 'kurt', 'site', 'Telefon', 'https://push.example/${dennis.family}', 'sealed-key', 'auth');
       insert into calendar_feeds (tenant_id, user_id, token_hash) values ('${north}', 'kurt', '${feed}');
       commit;`,
    )
    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('person', [dennis.person]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    try {
      // Opening the access again, a return, and a change of the working time,
      // a qualification, a device or a calendar feed all wait for the
      // deletion, and give up here after a moment: each would take its row
      // and then wait for the chain the deletion takes next.
      for (const statement of [
        `update memberships set last_day = null where tenant_id = '${north}' and user_id = 'kurt'`,
        `update people set left_on = null where id = '${dennis.person}'`,
        `update working_times set monday_minutes = 470 where person_id = '${dennis.person}'`,
        `update qualifications set note = 'berichtigt' where person_id = '${dennis.person}'`,
        `update push_subscriptions set label = 'Neues Telefon' where user_id = 'kurt'`,
        `update calendar_feeds set ended_at = now() where user_id = 'kurt'`,
      ]) {
        await ownTransaction(async (client) => {
          await client.query("set local lock_timeout = '300ms'")
          await expect(client.query(statement)).rejects.toThrow(/lock timeout/)
        })
      }

      // A new row that points at the file does not wait for it: it checks
      // the key once it took the counter, which the deletion waits for next.
      await ownTransaction(async (client) => {
        await client.query("set local lock_timeout = '300ms'")
        await client.query("select set_config('app.user_id', 'lena', true)")
        await client.query(
          `insert into leave_entitlements (tenant_id, person_id, year, entitled_half_days, carried_half_days)
           values ($1, $2, $3, 60, 0)`,
          [north, dennis.person, thisYear],
        )
      })
    } finally {
      stopped.release()
    }

    expect((await asked).status).toBe(201)
  })

  it('holds the file whose name goes with its last year before the first line of the protocol (#1033)', async () => {
    const dennis = await kraft(false)

    await pass()
    await erase('person', [dennis.person]).expect(201)

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [staffYearKey(dennis.person, oldYear)]).then(
      (answer) => answer,
    )

    await reachedBefore(stopped, asked)

    try {
      await ownTransaction(async (client) => {
        await client.query("set local lock_timeout = '300ms'")
        await expect(
          client.query('update people set name = name where id = $1', [dennis.person]),
        ).rejects.toThrow(/lock timeout/)
      })
    } finally {
      stopped.release()
    }

    expect((await asked).status).toBe(201)
    expect(
      await count(`select count(*) as n from people where id = $1 and name like 'Dennis%'`, [
        dennis.person,
      ]),
    ).toBe(0)
  })

  it('holds the rows of a year it deletes against a correction until it is through (#1033)', async () => {
    const dennis = await kraft(false)

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [staffYearKey(dennis.person, oldYear)]).then(
      (answer) => answer,
    )

    await reachedBefore(stopped, asked)

    try {
      // A correction of each kind that is corrected in its row waits for the
      // deletion, and gives up here after a moment.
      for (const statement of [
        `update leave_entitlements set carried_half_days = 5 where person_id = '${dennis.person}' and year = ${String(oldYear)}`,
        `update absences set note = 'berichtigt' where id = '${dennis.vacation}'`,
        `update on_call_shifts set note = 'berichtigt' where user_id = 'kurt' and extract(year from starts_at)::int = ${String(oldYear)}`,
      ]) {
        await ownTransaction(async (client) => {
          await client.query("set local lock_timeout = '300ms'")
          await expect(client.query(statement)).rejects.toThrow(/lock timeout/)
        })
      }
    } finally {
      stopped.release()
    }

    expect((await asked).status).toBe(201)
  })

  it('holds every sickness it deletes before the first line of the protocol (#1033)', async () => {
    const dennis = await kraft()

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('sickness', [dennis.oldSickness, dennis.dueSickness]).then(
      (answer) => answer,
    )

    await reachedBefore(stopped, asked)

    try {
      // Both are read again and held before the first line takes the chain of
      // the business: a deletion of the staff takes its rows first, as every
      // write of them does, and never waits for a row while it holds the
      // chain.
      for (const id of [dennis.oldSickness, dennis.dueSickness]) {
        await ownTransaction(async (client) => {
          await client.query("set local lock_timeout = '300ms'")
          await expect(
            // A sickness carries no note; a change that changes nothing
            // takes the row all the same.
            client.query('update absences set last_day = last_day where id = $1', [id]),
          ).rejects.toThrow(/lock timeout/)
        })
      }
    } finally {
      stopped.release()
    }

    expect((await asked).status).toBe(201)
  })

  it('lets a correction of time that comes while its year is deleted wait, and refuses it then (#1043)', async () => {
    const dennis = await kraft(false)
    const n = String(nextYear)
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    expect(((await dueFor(owner)) ?? []).map((entry) => entry.recordId)).toContain(key)

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [key]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    // A correction of the correction after New Year, entered now: of the old
    // year, since its chain began there, and not among what the deletion read.
    const corrected = ownTransaction(async (client) => {
      // As the person whose time it is: the trigger takes the author from the
      // transaction.
      await client.query(
        "select set_config('app.tenant_id', $1, true), set_config('app.user_id', 'kurt', true)",
        [north],
      )
      await client.query(
        `insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note, corrects_entry_id)
           values ($1, 'kurt', 'work', $2, $3, 'noch einmal berichtigt', $4)`,
        [north, `${n}-01-01 00:20+01`, `${n}-01-01 01:00+01`, dennis.correction],
      )
      await client.query('commit')

      return 'went through'
    }).catch((error: unknown) => (error as Error).message)

    await untilWaiting(stopped.holder(), 'advisory', 'insert into time_entries').finally(
      stopped.release,
    )

    expect((await asked).status).toBe(201)
    expect(await corrected).toBe(
      `Das Jahr ${String(oldYear)} dieser Person ist nach dem Löschkonzept gelöscht. ` +
        'Für dieses Jahr nimmt OpenGewerk nichts mehr an.',
    )
    // The year went whole, and the correction it never took is not there.
    expect(
      await count(
        "select count(*) as n from time_entries where user_id = 'kurt' and chain_year = $1",
        [oldYear],
      ),
    ).toBe(0)
  })

  it('lets a record of the year be changed in its row while the deletion holds its year, ordered by its row (#1043)', async () => {
    const dennis = await kraft(false)
    const o = String(oldYear)
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    // Held after it took the lock of the year and before it holds any row of it.
    const stopped = holdQuery(
      (statement) =>
        /from on_call_shifts\s+where user_id/i.test(statement) &&
        /for no key update/i.test(statement),
    )
    const asked = erase('staff_year', [key]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    try {
      // The office saves a time on call, an absence and days of leave of the
      // year as their forms send them, with the fields the year is read from.
      // A change in its year waits for no lock of the year and holds only its
      // row, so the deletion waits for it and not the other way round, which
      // would be a deadlock.
      for (const statement of [
        `update on_call_shifts set starts_at = starts_at, note = 'berichtigt'
          where user_id = 'kurt' and extract(year from (starts_at at time zone 'Europe/Berlin'))::int = ${o}`,
        `update absences set first_day = first_day, note = 'berichtigt' where id = '${dennis.vacation}'`,
        `update leave_entitlements set year = year, carried_half_days = 5
          where person_id = '${dennis.person}' and year = ${o}`,
      ]) {
        await ownTransaction(async (client) => {
          await client.query("set local lock_timeout = '300ms'")
          await client.query(statement)
        })
      }
    } finally {
      stopped.release()
    }

    expect((await asked).status).toBe(201)
  })

  it('answers a deletion that meets a transmission in a deadlock as busy, and the transmission goes through (#1043)', async () => {
    const dennis = await kraft(false)
    const n = String(nextYear)
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [key]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    // A transmission that wrote a record of this year first, and so holds the
    // counter of the business, and then a correction into the year the
    // deletion holds. The deletion waits for the counter first, and so it is
    // the one PostgreSQL breaks off.
    const transmitted = ownTransaction(async (client) => {
      await client.query(
        "select set_config('app.tenant_id', $1, true), set_config('app.user_id', 'kurt', true)",
        [north],
      )
      await client.query(
        `insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note)
           values ($1, 'kurt', 'work', $2, $3, 'heute')`,
        [north, `${String(thisYear)}-01-05 07:00+01`, `${String(thisYear)}-01-05 15:00+01`],
      )
      stopped.release()
      await waitingFor(admin, client, asked)
      await client.query(
        `insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note, corrects_entry_id)
           values ($1, 'kurt', 'work', $2, $3, 'noch einmal berichtigt', $4)`,
        [north, `${n}-01-01 00:20+01`, `${n}-01-01 01:00+01`, dennis.correction],
      )
      await client.query('commit')

      return 'went through'
    }).catch((error: unknown) => (error as Error).message)

    const answer = await asked

    expect(answer.status).toBe(409)
    expect(refusal(answer)).toContain('gleichzeitig wurde ein Eintrag dafür geschrieben')
    expect(await transmitted).toBe('went through')
    expect(await count('select count(*) as n from erasures where record_id = $1', [key])).toBe(0)
  })

  it('refuses a record of any of the four kinds in a year that went, and takes one of a year kept (#1043)', async () => {
    const dennis = await kraft(false)
    const o = String(oldYear)
    const sentence =
      `Das Jahr ${o} dieser Person ist nach dem Löschkonzept gelöscht. ` +
      'Für dieses Jahr nimmt OpenGewerk nichts mehr an.'
    const written = (statement: string) =>
      ownTransaction(async (client) => {
        await client.query("select set_config('app.user_id', 'kurt', true)")
        await client.query(statement)

        return 'went through'
      }).catch((error: unknown) => (error as Error).message)

    await pass()
    await erase('staff_year', [staffYearKey(dennis.person, oldYear)]).expect(201)

    for (const statement of [
      `insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note)
         values ('${north}', 'kurt', 'work', '${o}-06-02 07:00+02', '${o}-06-02 15:00+02', 'nachgetragen')`,
      `insert into on_call_shifts (tenant_id, user_id, starts_at, ends_at, note)
         values ('${north}', 'kurt', '${o}-06-05 16:00+02', '${o}-06-06 07:00+02', 'nachgetragen')`,
      `insert into absences (tenant_id, person_id, kind, state, first_day, last_day, note)
         values ('${north}', '${dennis.person}', 'vacation', 'approved', '${o}-09-01', '${o}-09-02', 'nachgetragen')`,
      `insert into leave_entitlements (tenant_id, person_id, year, entitled_half_days, carried_half_days)
         values ('${north}', '${dennis.person}', ${o}, 60, 0)`,
    ]) {
      expect(await written(statement)).toBe(sentence)
    }

    // Moved into the year that went, an absence of a year kept is refused too.
    await admin.query(
      `insert into absences (tenant_id, person_id, kind, state, first_day, last_day, note)
         values ($1, $2, 'vacation', 'approved', $3, $4, 'verschoben')`,
      [north, dennis.person, `${String(thisYear)}-09-01`, `${String(thisYear)}-09-02`],
    )

    expect(
      await written(
        `update absences set first_day = '${o}-09-01', last_day = '${o}-09-02' where note = 'verschoben'`,
      ),
    ).toBe(sentence)
    // A year kept takes records as before.
    expect(
      await written(
        `insert into leave_entitlements (tenant_id, person_id, year, entitled_half_days, carried_half_days)
           values ('${north}', '${dennis.person}', ${String(thisYear)}, 60, 0)`,
      ),
    ).toBe('went through')
    // And so it is for the application role, in the name of the office: the
    // trigger sees the line of the protocol whatever the person may read on
    // the page.
    expect(
      await refusedWith(
        database.forTenant({ tenantId: north, userId: 'bruno' }, (tx) =>
          tx.execute(
            sql.raw(`insert into absences (tenant_id, person_id, kind, state, first_day, last_day, note)
              values ('${north}', '${dennis.person}', 'vacation', 'approved', '${o}-11-02', '${o}-11-03', 'vom Büro')`),
          ),
        ),
      ),
    ).toBe(sentence)
  })

  it('writes the day of a sickness as read again into its line of the protocol (#1033)', async () => {
    const dennis = await kraft()
    const corrected = `${String(oldYear)}-05-11` as IsoDate

    await pass()

    const stopped = holdQuery((statement) => /select last_day::text from absences/i.test(statement))
    const asked = erase('sickness', [dennis.oldSickness]).then((answer) => answer)

    await reachedBefore(stopped, asked)
    // Its last day corrected after the list was read, and before the
    // deletion reads it again.
    await admin
      .query('update absences set last_day = $2 where id = $1', [dennis.oldSickness, corrected])
      .finally(stopped.release)

    expect((await asked).status).toBe(201)

    const { rows } = await admin.query<{ label: string; due_on: string }>(
      'select label, due_on::text from erasures where record_id = $1',
      [dennis.oldSickness],
    )

    expect(rows).toEqual([
      {
        label: sicknessErasureLabel(corrected),
        due_on: sicknessErasureDueOn(corrected, today, shippedRules),
      },
    ])
  })

  it('refuses a sickness whose last day was corrected so that it is not due, and deletes nothing (#1033)', async () => {
    const dennis = await kraft()

    await pass()

    const stopped = holdQuery((statement) => /select last_day::text from absences/i.test(statement))
    const asked = erase('sickness', [dennis.oldSickness]).then((answer) => answer)

    await reachedBefore(stopped, asked)
    // Its last day corrected after the list was read to one a hundred days
    // back, and before the deletion reads it again: no longer due.
    await admin
      .query('update absences set last_day = $2 where id = $1', [
        dennis.oldSickness,
        addDays(today, -100),
      ])
      .finally(stopped.release)

    expect((await asked).status).toBe(409)
    expect(
      await count('select count(*) as n from absences where id = $1', [dennis.oldSickness]),
    ).toBe(1)
    expect(
      await count('select count(*) as n from erasures where record_id = $1', [dennis.oldSickness]),
    ).toBe(0)
  })

  it('writes no line for a year that another deletion emptied meanwhile (#1033)', async () => {
    const dennis = await kraft(false)
    const key = staffYearKey(dennis.person, oldYear)

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [key]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    // The same year asked for a second time, as a second click does: it read
    // the list as well and waits for the first.
    const again = erase('staff_year', [key]).then((answer) => answer)

    await untilWaiting(stopped.holder(), 'advisory', 'pg_advisory_xact_lock').finally(
      stopped.release,
    )

    expect((await asked).status).toBe(201)
    expect((await again).status).toBe(409)
    expect(await count('select count(*) as n from erasures where record_id = $1', [key])).toBe(1)
  })

  it('lets a second deletion of the same person wait until the first is through (#1033)', async () => {
    const dennis = await kraft()

    await pass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('staff_year', [staffYearKey(dennis.person, oldYear)]).then(
      (answer) => answer,
    )

    await reachedBefore(stopped, asked)

    // A sickness of a later year, rows the year does not hold: it waits all
    // the same, at the lock of the person, and not somewhere in between.
    let through = false
    const sickness = erase('sickness', [dennis.dueSickness]).then((answer) => {
      through = true

      return answer
    })

    await untilWaiting(stopped.holder(), 'advisory', 'pg_advisory_xact_lock').finally(
      stopped.release,
    )

    expect(through).toBe(false)
    expect((await asked).status).toBe(201)
    expect((await sickness).status).toBe(201)
  })

  it('lets a deletion by itself give way to one by hand of the same person, and tries again in the next pass (#1033)', async () => {
    const dennis = await kraft()

    await byItself('sickness')
    await nightPass()

    const stopped = holdQuery((statement) => protocolLine.test(statement))
    const asked = erase('person', [dennis.person]).then((answer) => answer)

    await reachedBefore(stopped, asked)

    // The pass claims the deadline of each sickness and with it the chain of
    // the business, which the deletion by hand needs for its line next. It
    // does not wait for the lock of the person but gives up.
    let failed: unknown

    try {
      let ended = false

      failed = await Promise.race([
        noonPass()
          .then(
            () => 'went through',
            (error: unknown) => error,
          )
          .finally(() => {
            ended = true
          }),
        untilWaiting(stopped.holder(), 'advisory', undefined, () => ended).then(
          () => 'waited for the person',
        ),
      ])
    } finally {
      stopped.release()
    }

    expect(reasonsOf(failed).length).toBe(2)
    expect(reasonsOf(failed).every((reason) => reason instanceof ErasureBusy)).toBe(true)
    expect((await asked).status).toBe(201)
    expect(
      await count(`select count(*) as n from absences where id = any($1)`, [
        [dennis.dueSickness, dennis.oldSickness],
      ]),
    ).toBe(2)

    // Nothing of the claim stayed: the next pass deletes them.
    await noonPass()

    expect(
      await count(`select count(*) as n from absences where id = any($1)`, [
        [dennis.dueSickness, dennis.oldSickness],
      ]),
    ).toBe(0)
  })

  for (const change of [
    {
      kind: 'staff_year',
      what: 'an absence of the year',
      statement: (dennis: Fixture) =>
        [`update absences set note = 'berichtigt' where id = $1`, [dennis.vacation]] as const,
    },
    {
      kind: 'person',
      what: 'the access',
      statement: () =>
        [
          `update memberships set last_day = last_day where tenant_id = $1 and user_id = 'kurt'`,
          [north],
        ] as const,
    },
  ]) {
    it(`lets a deletion by itself give way to a change by hand of ${change.what}, which goes through (#1033)`, async () => {
      const dennis = await kraft(false)

      await byItself(change.kind)
      await nightPass()

      // Held after the pass claimed the deadline, before it takes the person.
      const stopped = holdQuery((statement) => /pg_try_advisory_xact_lock/i.test(statement))
      const run = noonPass().then(
        () => 'went through',
        (error: unknown) => error,
      )

      await Promise.race([
        stopped.reached,
        run.then((ended) => {
          throw new Error(`The pass ended before the lock of the person: ${String(ended)}`)
        }),
      ])

      const client = await admin.connect()
      let broken = false

      try {
        await client.query('begin')
        await client.query("select set_config('app.user_id', 'lena', true)")

        // The office changes a row the deletion holds: it takes the row and
        // waits for the chain, which the pass holds with its claim.
        const [statement, values] = change.statement(dennis)
        const changed = client.query(statement, [...values])

        changed.catch(() => undefined)
        await untilWaiting(stopped.holder()).finally(stopped.release)

        // The pass gives up and rolls back, and the change goes through. Its
        // commit comes before the end of the pass: the pass goes on to the
        // next deadline, whose claim waits for the chain the change holds.
        await expect(changed).resolves.toMatchObject({ rowCount: 1 })
        await client.query('commit')
      } finally {
        await client.query('rollback').catch(() => {
          broken = true
        })
        client.release(broken)
      }

      const failed = await run

      expect(reasonsOf(failed).every((reason) => reason instanceof ErasureBusy)).toBe(true)
    })
  }

  for (const record of [
    {
      kind: 'an absence',
      insert: (n: string, person: string) =>
        `insert into absences (id, tenant_id, person_id, kind, state, first_day, last_day, note, created_at, updated_at)
           values ('${newId<'absence'>()}', '${north}', '${person}', 'vacation', 'approved',
                   '${n}-12-28', '${n}-12-31', 'Urlaub über Neujahr', '${n}-12-01 09:00+01', '${n}-12-01 09:00+01')`,
      prolong: (n: string, person: string) =>
        `update absences set last_day = '${String(Number(n) + 1)}-01-03' where person_id = '${person}' and note = 'Urlaub über Neujahr'`,
    },
    {
      kind: 'a record of time',
      insert: (n: string) =>
        `insert into time_entries (tenant_id, user_id, kind, started_at, ended_at, note, chain_year, created_at, updated_at)
           values ('${north}', 'kurt', 'work', '${n}-12-31 21:00+01', '${n}-12-31 23:30+01', 'Silvester', ${n},
                   '${n}-12-31 23:30+01', '${n}-12-31 23:30+01')`,
      prolong: (n: string) =>
        `update time_entries set ended_at = '${String(Number(n) + 1)}-01-01 01:00+01' where user_id = 'kurt' and note = 'Silvester'`,
    },
    {
      kind: 'a time on call',
      insert: (n: string) =>
        `insert into on_call_shifts (tenant_id, user_id, starts_at, ends_at, note, created_at, updated_at)
           values ('${north}', 'kurt', '${n}-12-28 16:00+01', '${n}-12-31 07:00+01', 'Bereitschaft',
                   '${n}-12-01 09:00+01', '${n}-12-01 09:00+01')`,
      prolong: (n: string) =>
        `update on_call_shifts set ends_at = '${String(Number(n) + 1)}-01-04 07:00+01' where user_id = 'kurt' and note = 'Bereitschaft'`,
    },
  ]) {
    it(`holds a year with ${record.kind} into the next until the end of that year (#1033)`, async () => {
      const dennis = await kraft(false)
      const n = String(nextYear)
      const key = staffYearKey(dennis.person, nextYear)
      const year = {
        key,
        personId: dennis.person,
        personName: 'Dennis',
        userId: 'kurt',
        year: nextYear,
        countsFrom: nextYear,
        dueOn: today,
      }
      const listed = async () => {
        await pass()

        return ((await dueFor(owner)) ?? []).map((entry) => entry.recordId)
      }
      const held = () =>
        database.forTenant({ tenantId: north, userId: 'lena' }, (tx) =>
          holdStaffYear(tx, year, today),
        )
      // Written past the triggers, so that the moment of writing stays as
      // given and only the end of the record moves.
      const quietly = (statement: string) =>
        admin.query(`begin; set local session_replication_role = replica; ${statement}; commit;`)

      // Ending on 31 December, its year is due by its own end.
      await quietly(record.insert(n, dennis.person))

      expect(await listed()).toContain(key)
      expect(await held()).not.toBeNull()

      // Ending after New Year, the days of January belong to the pay of the
      // year after, and the year is kept until that one's end.
      await quietly(record.prolong(n, dennis.person))

      expect(await listed()).not.toContain(key)
      expect(await held()).toBeNull()
    })
  }

  it('puts a whole chain of corrections into the year of its first entry, past a hundred links too, and deletes it with that year (#1044)', async () => {
    const dennis = await kraft(false)
    const before = String(oldYear - 1)
    const o = String(oldYear)
    const key = staffYearKey(dennis.person, oldYear - 1)

    // An entry on New Year's Eve the year before, a correction that moves it
    // past New Year, and a hundred corrections of that one, all of them long
    // ago. Until 0161 the last of them, a hundred and one links from the
    // first, counted with the year of the first correction, and the two years
    // held each other.
    await admin.query(
      `begin; set local app.user_id = 'kurt';
       do $$
       begin
         for i in 0..101 loop
           insert into time_entries (id, tenant_id, user_id, kind, started_at, ended_at, note, corrects_entry_id)
           values (md5('${dennis.family}' || i)::uuid, '${north}', 'kurt', 'work',
                   case when i = 0 then '${before}-12-31 22:00+01' else '${o}-01-01 00:10+01' end::timestamptz,
                   case when i = 0 then '${before}-12-31 23:30+01' else '${o}-01-01 01:00+01' end::timestamptz,
                   'Kette', case when i = 0 then null else md5('${dennis.family}' || (i - 1))::uuid end);
         end loop;
       end
       $$;
       set local session_replication_role = replica;
       update time_entries set updated_at = '${o}-01-01 01:00+01' where note = 'Kette';
       commit;`,
    )

    expect(
      await count(
        `select count(*) as n from time_entries
          where note = 'Kette' and chain_year = $1 and time_entry_year(id) = $1`,
        [oldYear - 1],
      ),
    ).toBe(102)

    await pass()

    expect(((await dueFor(owner)) ?? []).map((entry) => entry.recordId)).toContain(key)

    await erase('staff_year', [key]).expect(201)

    // The whole chain went with the year before, and the old year keeps its own.
    expect(await count("select count(*) as n from time_entries where note = 'Kette'")).toBe(0)
    expect(
      await count(
        "select count(*) as n from time_entries where user_id = 'kurt' and chain_year = $1",
        [oldYear],
      ),
    ).toBeGreaterThan(0)
  })

  it('shows a sickness to whoever keeps absences and a file only to whoever reads the files, in the list of deadlines as well', async () => {
    await kraft()
    await pass()

    expect(((await dueFor(office)) ?? []).map((entry) => entry.kind).sort()).toEqual([
      'sickness',
      'sickness',
    ])

    const kinds = async (who: string) => {
      const answer = await http()
        .get('/deadlines?status=all')
        .set('x-test-identity', who)
        .expect(200)

      return [...new Set((answer.body as { rows: { kind: string }[] }).rows.map((row) => row.kind))]
        .filter((kind) => kind.startsWith('privacy.'))
        .sort()
    }

    expect(await kinds(owner)).toEqual([
      'privacy.person_erasure',
      'privacy.sickness_erasure',
      'privacy.staff_year_erasure',
    ])
    expect(await kinds(office)).toEqual(['privacy.sickness_erasure'])
  })

  it('keeps a file while its access has not ended, and says why', async () => {
    const dennis = await kraft()

    await admin.query(
      `update memberships set last_day = null where tenant_id = $1 and user_id = 'kurt'`,
      [north],
    )
    await pass()

    expect(((await dueFor(owner)) ?? []).some((entry) => entry.kind === 'person')).toBe(false)

    const refused = await erase('person', [dennis.person]).expect(409)

    expect(refusal(refused)).toBe(
      'Eine ausgewählte Akte bleibt noch: Ihr Zugang hat keinen letzten Tag, der vorbei ist.',
    )
    expect(
      await count(`select count(*) as n from working_times where person_id = $1`, [dennis.person]),
    ).toBe(1)
  })

  it('refuses what is not due, and deletes none of those asked for', async () => {
    const dennis = await kraft()

    await pass()

    const refused = await erase('sickness', [dennis.dueSickness, dennis.freshSickness]).expect(409)

    expect(refusal(refused)).toContain('nicht zum Löschen fällig')
    expect(await count(`select count(*) as n from absences where kind = 'sickness'`)).toBe(3)
    await erase('staff_year', [staffYearKey(dennis.person, nextYear)]).expect(409)
    expect(await count(`select count(*) as n from erasures`)).toBe(0)
  })
})

describe('a sickness that is due', () => {
  it('goes, every value of it blacked out, and the line of the protocol names the day and nobody', async () => {
    const dennis = await kraft()

    await pass()
    await erase('sickness', [dennis.dueSickness]).expect(201)

    expect(
      await count(`select count(*) as n from absences where id = $1`, [dennis.dueSickness]),
    ).toBe(0)
    expect(
      await count(
        `select count(*) as n from audit_entries
          where table_name = 'absences' and record_id = $1 and (old_value is not null or new_value is not null)`,
        [dennis.dueSickness],
      ),
    ).toBe(0)

    const { rows } = await admin.query<{ label: string; redactions: number; created_by: string }>(
      `select label, redactions, created_by from erasures where kind::text = 'sickness'`,
    )

    expect(rows).toEqual([
      {
        label: `Krankheit, letzter Tag ${germanDay(addDays(today, -400))}`,
        redactions: expect.any(Number),
        created_by: 'lena',
      },
    ])
    expect(rows[0]?.redactions).toBeGreaterThan(0)
  })

  it('is for whoever leads the business', async () => {
    const dennis = await kraft()

    await pass()
    await erase('sickness', [dennis.dueSickness], office).expect(403)
    expect(
      await count(`select count(*) as n from absences where id = $1`, [dennis.dueSickness]),
    ).toBe(1)
  })
})

describe('the locks of the database (0131)', () => {
  it('let nothing of the staff go without a line of the protocol in the same transaction', async () => {
    const dennis = await kraft()
    const refusals = [
      [`delete from absences where id = '${dennis.dueSickness}'`, 'Eine Abwesenheit wird nur'],
      [`delete from absences where id = '${dennis.vacation}'`, 'Eine Abwesenheit wird nur'],
      [
        `delete from leave_entitlements where person_id = '${dennis.person}'`,
        'Der Urlaubsanspruch',
      ],
      [
        `delete from working_times where person_id = '${dennis.person}'`,
        'Eine vereinbarte Arbeitszeit',
      ],
      [`delete from qualifications where person_id = '${dennis.person}'`, 'Eine Qualifikation'],
      [`delete from location_consents where user_id = 'kurt'`, 'Eine Antwort zur Erfassung'],
      [`delete from on_call_shifts where user_id = 'kurt'`, 'Eine Zeit der Rufbereitschaft'],
      [`delete from time_entries where id = '${dennis.correction}'`, 'Ein Zeiteintrag wird'],
    ] as const

    for (const [statement, sentence] of refusals) {
      expect(await refusedWith(asApplication(statement))).toContain(sentence)
    }
  })

  it('let a year go only with its own line, and not the year after with it', async () => {
    const dennis = await kraft()
    const line = (key: string) =>
      `insert into erasures (tenant_id, kind, record_id, label, automatic, redactions, created_by)
         values ('${north}', 'staff_year', '${key}', 'Probe', false, 0, 'lena');`

    // The line of the old year opens the old year, and nothing of the next.
    expect(
      await refusedWith(
        asApplication(
          `${line(staffYearKey(dennis.person, oldYear))}
           delete from leave_entitlements where person_id = '${dennis.person}' and year = ${String(nextYear)};`,
        ),
      ),
    ).toContain('Der Urlaubsanspruch')
    expect(
      await refusedWith(
        asApplication(
          `${line(staffYearKey(dennis.person, oldYear))}
           delete from leave_entitlements where person_id = '${dennis.person}' and year = ${String(oldYear)};`,
        ),
      ),
    ).toBe('went through')
  })
})

describe('a year of a person that is due', () => {
  it('takes the time, the times on call, the absences and the days of leave of that year, a correction after New Year with its entry, and leaves the year after', async () => {
    const dennis = await kraft()

    await pass()
    await erase('staff_year', [staffYearKey(dennis.person, oldYear)]).expect(201)

    const years = async (table: string, column: string, where: string) => {
      const { rows } = await admin.query<{ year: number }>(
        `select distinct extract(year from (${column}))::int as year from ${table} where ${where} order by 1`,
      )

      return rows.map((row) => Number(row.year))
    }

    expect(
      await years('time_entries', "started_at at time zone 'Europe/Berlin'", `user_id = 'kurt'`),
    ).toEqual([nextYear])
    expect(
      await count(`select count(*) as n from time_entries where id in ($1, $2)`, [
        dennis.lastEntry,
        dennis.correction,
      ]),
    ).toBe(0)
    expect(
      await years('on_call_shifts', "starts_at at time zone 'Europe/Berlin'", `user_id = 'kurt'`),
    ).toEqual([nextYear])
    expect(
      await years('absences', 'first_day', `person_id = '${dennis.person}' and kind = 'vacation'`),
    ).toEqual([nextYear])
    expect(
      await years('leave_entitlements', 'make_date(year, 1, 1)', `person_id = '${dennis.person}'`),
    ).toEqual([nextYear])

    // The file, the name and the answer about the place stay: the file is not due with it.
    expect(
      await count(`select count(*) as n from people where id = $1 and name = $2`, [
        dennis.person,
        `Dennis ${dennis.family}`,
      ]),
    ).toBe(1)
    expect(await count(`select count(*) as n from location_consents where user_id = 'kurt'`)).toBe(
      1,
    )

    const { rows } = await admin.query<{ label: string; record_id: string }>(
      `select label, record_id::text from erasures where kind::text = 'staff_year'`,
    )

    expect(rows).toEqual([
      {
        label: `Arbeitszeiten und Urlaub ${String(oldYear)}`,
        record_id: staffYearKey(dennis.person, oldYear),
      },
    ])
  })

  it('makes every device drop the records of time and the times on call it holds', async () => {
    const dennis = await kraft()
    const narrowed = async () => {
      const answer = await http()
        .get('/sync?since=0')
        .set('x-test-identity', technician)
        .expect(200)

      return (answer.body as { narrowed: Record<string, string> }).narrowed
    }

    const before = await narrowed()

    expect(before['time_entries']).toBe('user:kurt')
    await pass()
    await erase('staff_year', [staffYearKey(dennis.person, oldYear)]).expect(201)

    const after = await narrowed()

    expect(after['time_entries']).toBe('user:kurt:erased:1')
    expect(after['on_call_shifts']).not.toBe(before['on_call_shifts'])
  })
})

describe('the file of somebody who left', () => {
  it('takes the working time, the qualifications with the certificate and the data of the account, and keeps the name while a year is kept', async () => {
    const dennis = await kraft()

    await pass()
    await erase('person', [dennis.person]).expect(201)

    expect(
      await count(`select count(*) as n from working_times where person_id = $1`, [dennis.person]),
    ).toBe(0)
    expect(
      await count(`select count(*) as n from qualifications where person_id = $1`, [dennis.person]),
    ).toBe(0)
    expect(
      await count(`select count(*) as n from files where sha256 = $1`, [dennis.certificate]),
    ).toBe(0)
    // The one the qualification named before goes with it (opengewerk#802).
    expect(
      await count(`select count(*) as n from replaced_certificates where person_id = $1`, [
        dennis.person,
      ]),
    ).toBe(0)
    expect(
      await count(`select count(*) as n from files where sha256 = $1`, [dennis.earlierCertificate]),
    ).toBe(0)

    const { rows: files } = await admin.query<{
      name: string
      joined_on: string | null
      deleted: boolean
    }>(`select name, joined_on, deleted_at is not null as deleted from people where id = $1`, [
      dennis.person,
    ])

    expect(files).toEqual([{ name: `Dennis ${dennis.family}`, joined_on: null, deleted: true }])

    const { rows: accounts } = await admin.query<{ name: string; email: string }>(
      `select name, email from auth_users where id = 'kurt'`,
    )

    expect(accounts).toEqual([{ name: `Dennis ${dennis.family}`, email: removedAddress('kurt') }])
  })

  it('keeps a certificate, of now or of before, that a price list import or a written document still names by a value', async () => {
    const dennis = await kraft()
    const { rows: suppliers } = await admin.query<{ id: string }>(
      `insert into suppliers (tenant_id, name) values ($1, 'Hansa Elektro') returning id`,
      [north],
    )
    const { rows: customers } = await admin.query<{ id: string }>(
      `insert into customers (tenant_id, kind, name) values ($1, 'business', 'Logo GmbH') returning id`,
      [north],
    )
    const { rows: documents } = await admin.query<{ id: string }>(
      `insert into documents (tenant_id, customer_id, kind, document_date)
       values ($1, $2, 'quote', '2026-10-01') returning id`,
      [north, customers[0]?.id],
    )

    // Neither holds its file by a key: the import in its list of files, the
    // document in what it wrote, as the logo of its letterhead then.
    await admin.query(
      `insert into article_imports (tenant_id, supplier_id, files, valid_from) values ($1, $2, $3, '2026-10-01')`,
      [
        north,
        suppliers[0]?.id,
        JSON.stringify([{ name: 'preise.001', sha256: dennis.certificate, bytes: 12 }]),
      ],
    )
    await admin.query(
      'insert into document_snapshots (tenant_id, document_id, content) values ($1, $2, $3)',
      [
        north,
        documents[0]?.id,
        JSON.stringify({
          issuer: {
            logo: { fileId: newId(), sha256: dennis.earlierCertificate, mediaType: 'image/png' },
          },
        }),
      ],
    )

    await pass()
    await erase('person', [dennis.person]).expect(201)

    expect(
      await count(`select count(*) as n from qualifications where person_id = $1`, [dennis.person]),
    ).toBe(0)
    expect(
      await count(`select count(*) as n from files where sha256 = $1`, [dennis.certificate]),
    ).toBe(1)
    expect(
      await count(`select count(*) as n from files where sha256 = $1`, [dennis.earlierCertificate]),
    ).toBe(1)
  })

  it('loses the name with the last year, and with it the answer about the place and the name of the account; nothing of the person is left', async () => {
    // Only the old year is kept: nothing came after, no sickness either.
    const dennis = await kraft(false)

    await pass()
    await erase('person', [dennis.person]).expect(201)
    await pass()
    await erase('staff_year', [staffYearKey(dennis.person, oldYear)]).expect(201)

    const { rows } = await admin.query<{ name: string; user_id: string }>(
      `select name, user_id from people where id = $1`,
      [dennis.person],
    )

    expect(rows).toEqual([{ name: 'Gelöschte Person', user_id: 'kurt' }])
    expect(await count(`select count(*) as n from location_consents where user_id = 'kurt'`)).toBe(
      0,
    )
    expect(
      (await admin.query<{ name: string }>(`select name from auth_users where id = 'kurt'`)).rows,
    ).toEqual([{ name: 'Gelöschter Zugang' }])
    expect(await tracesOf(dennis.family)).toEqual([])
  })

  it('goes by itself where the business switched it on, in the name of who did', async () => {
    const dennis = await kraft()

    await admin.query(
      `begin; set local app.user_id = 'lena';
       insert into erasure_automations (tenant_id, kind, created_by) values ('${north}', 'sickness', 'lena');
       commit;`,
    )
    // What a deadline does waits for the morning of its day: the pass runs at noon.
    await runDeadlinesOf({ database }, north, new Date(`${berlinClock(new Date()).day}T10:00:00Z`))

    expect(
      await count(`select count(*) as n from absences where id = $1`, [dennis.dueSickness]),
    ).toBe(0)
    expect(
      await count(`select count(*) as n from absences where id = $1`, [dennis.freshSickness]),
    ).toBe(1)
    expect(
      (
        await admin.query<{ automatic: boolean; created_by: string }>(
          `select automatic, created_by from erasures where kind::text = 'sickness' order by created_at`,
        )
      ).rows,
    ).toEqual([
      { automatic: true, created_by: 'lena' },
      { automatic: true, created_by: 'lena' },
    ])
  })
})

function germanDay(day: IsoDate): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`
}
