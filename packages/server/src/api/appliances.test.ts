import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { permissionCatalogue, type RoleKey, shippedRoles, type TenantId } from '@opengewerk/domain'
import {
  Database,
  FileStore,
  newId,
  type PrintJob,
  type Renderer,
} from '@opengewerk/platform-server'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applicationDatabaseUrl,
  checkViolation,
  connect,
  refusedBy,
  resetToMigrated,
} from '../database/test-database.js'
import { ApiModule } from './api.module.js'
import { photoBound, printedPhotos, rendererRequestBytes } from '../forms/photo-bound.js'
import { photosToRead, shownVersions } from './protocol-photos.js'
import { binary } from './test-binary.js'
import { waitingFor } from './test-hold.js'
import { as, testIdentities as identities } from './test-identity.js'
import { changed, created, deleted, push } from './test-structure.js'

/**
 * The register of appliances and their test after DGUV Vorschrift 3 (#303):
 * an appliance is made at a site through the outbox, like an installation;
 * its test hangs on it and on nothing else; a technician's device holds the
 * appliances of the sites of its jobs; the protocol prints its limits worked
 * out of the appliance, and the report of a site lists every appliance with
 * its last signed test.
 */

const north = { id: newId<'tenant'>() as TenantId, name: 'Elektro Nord GmbH' }
const south = { id: newId<'tenant'>() as TenantId, name: 'Elektro Süd GmbH' }

let admin: Pool
let database: Database
let app: INestApplication
let site = ''
let customer = ''
let installation = ''
let storageRoot = ''

const jobs: PrintJob[] = []
const standIn: Renderer = (job) => {
  jobs.push(job)

  return Promise.resolve(new TextEncoder().encode('%PDF-1.7 Probedruck'))
}

function person(userId: string, ...roles: RoleKey[]): string {
  return JSON.stringify({ userId, tenantId: north.id, roles })
}

function http() {
  return request(app.getHttpServer())
}

async function post(path: string, body: Record<string, unknown>, who: string) {
  const answer = await http().post(path).set('x-test-identity', who).send(body).expect(201)

  return String((answer.body as { id: string }).id)
}

const signature = {
  name: 'Anna Weber',
  path: 'M10,10L200,120L400,80',
  signedAt: '2026-11-02T10:00:00.000Z',
}

/** Everything the test needs before it can be signed. */
function complete(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tester: 'Anna Weber',
    test_kind: 'recurring',
    housing: 'ok',
    cord: 'ok',
    plug: 'ok',
    markings: 'ok',
    suitability: 'ok',
    function: 'ok',
    safety_devices: 'not_applicable',
    verdict: 'passed',
    next_inspection_months: 12_000,
    ...over,
  })
}

function anAppliance(id: string, fields: Record<string, unknown> = {}) {
  return created('appliances', id, {
    siteId: site,
    inventoryNumber: '002',
    designation: 'Verlängerungsleitung 25 m',
    protectionClass: 'I',
    mobility: 'portable',
    cordLengthMilli: 25_000,
    ...fields,
  } as never)
}

function aTest(
  id: string,
  subject: Record<string, unknown>,
  values = complete(),
  performedOn = '2026-11-02',
) {
  return created('form_records', id, {
    definitionKey: 'dguv-v3',
    definitionVersion: 1,
    performedOn,
    status: 'draft',
    values,
    ...subject,
  } as never)
}

/** Signs a draft made with `aTest`, as the device does. */
function signed(id: string, before: string, after: string) {
  return changed('form_records', id, {
    status: { from: 'draft', to: 'signed' },
    values: { from: before, to: after },
  })
}

beforeAll(async () => {
  admin = await connect()
  await resetToMigrated()
  await admin.query('insert into tenants (id, name) values ($1, $2), ($3, $4)', [
    north.id,
    north.name,
    south.id,
    south.name,
  ])
  await admin.query(
    `insert into auth_users (id, name, email) values ('max', 'Max Monteur', 'max@example.de')`,
  )
  await admin.query(
    `insert into memberships (tenant_id, user_id, roles) values ($1, 'max', '{technician}')`,
    [north.id],
  )

  database = Database.connect(applicationDatabaseUrl())
  storageRoot = mkdtempSync(join(tmpdir(), 'opengewerk-appliances-'))

  const built = await Test.createTestingModule({
    imports: [
      ApiModule.create(database, identities, {
        renderer: standIn,
        files: new FileStore(storageRoot),
      }),
    ],
  }).compile()

  app = built.createNestApplication()
  await app.init()

  const office = as(north.id, 'office')

  customer = await post('/customers', { kind: 'business', name: 'Hausverwaltung Süd GmbH' }, office)
  site = await post(
    '/sites',
    {
      customerId: customer,
      designation: 'Rheinstraße 12',
      street: 'Rheinstraße',
      houseNumber: '12',
      postalCode: '68159',
      city: 'Mannheim',
    },
    office,
  )
  installation = await post(
    '/installations',
    { siteId: site, kind: 'meter_cabinet', designation: 'Zählerschrank' },
    office,
  )
})

afterAll(async () => {
  await app.close()
  await database.close()
  await admin.end()
  rmSync(storageRoot, { recursive: true, force: true })
})

describe('an appliance of the register', () => {
  it('is made at a site through the outbox, on site as in the office', async () => {
    const id = newId<'appliance'>()
    const { receipts } = await push(app, as(north.id, 'technician'), [anAppliance(id)])

    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])

    const { rows } = await admin.query(
      'select site_id, designation, protection_class, cord_length_milli from appliances where id = $1',
      [id],
    )

    expect(rows).toEqual([
      {
        site_id: site,
        designation: 'Verlängerungsleitung 25 m',
        protection_class: 'I',
        cord_length_milli: 25_000,
      },
    ])
  })

  it('is refused without a designation, and with a lead that has no length', async () => {
    const office = as(north.id, 'office')
    const unnamed = await push(
      app,
      office,
      [anAppliance(newId<'appliance'>(), { designation: ' ' })],
      400,
    )
    const nothing = await push(
      app,
      office,
      [anAppliance(newId<'appliance'>(), { cordLengthMilli: 0 })],
      400,
    )

    expect(unnamed.message).toBe('Ein Gerät braucht eine Bezeichnung.')
    expect(nothing.message).toBe('Die Länge ist größer als 0 und höchstens 1000 m.')
  })

  it('is written by nobody without the right to change installations', async () => {
    // Everything a technician may, but changing the installations: the
    // register is part of the installations of a site, and so is their right.
    const technician = shippedRoles.find((role) => role.key === 'technician')
    const rights = permissionCatalogue.sumOf(technician ? [technician] : []).rights
    const who = (held: readonly string[]) =>
      JSON.stringify({ userId: 'lena', tenantId: north.id, roles: [], rights: held })

    const refused = await push(
      app,
      who(rights.filter((right) => right !== 'installation.write')),
      [anAppliance(newId<'appliance'>())],
      400,
    )

    expect(refused.message).toBe(
      'Anlagen bearbeiten darf dieser Zugang nicht. Der Inhaber vergibt die Rollen unter „Zugänge“.',
    )

    const { receipts } = await push(app, who(rights), [anAppliance(newId<'appliance'>())])

    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])
  })

  it('is held by the database to a designation and a lead of a length, whichever way it comes', async () => {
    expect(
      await refusedBy(
        admin.query(
          `insert into appliances (tenant_id, site_id, designation, protection_class, cord_length_milli)
         values ($1, $2, 'Bohrhammer', 'II', 0)`,
          [north.id, site],
        ),
      ),
    ).toEqual({ code: checkViolation, constraint: 'appliances_cord_length' })
    expect(
      await refusedBy(
        admin.query(
          `insert into appliances (tenant_id, site_id, designation, protection_class)
         values ($1, $2, '  ', 'II')`,
          [north.id, site],
        ),
      ),
    ).toEqual({ code: checkViolation, constraint: 'appliances_designation_named' })
  })

  it('reaches a device with the sites of its jobs and no other', async () => {
    const technician = person('max', 'technician')
    const office = as(north.id, 'office')
    const id = newId<'appliance'>()

    await push(app, office, [
      anAppliance(id, { inventoryNumber: '007', designation: 'Waschmaschine' }),
    ])

    const pulled = async () => {
      const answer = await http()
        .get('/sync?since=0')
        .set('x-test-identity', technician)
        .expect(200)
      const changes = (answer.body as { changes: { entity: string; rows: { id: string }[] }[] })
        .changes

      return (
        changes.find((change) => change.entity === 'appliances')?.rows.map((row) => row.id) ?? []
      )
    }

    // On no job, the technician holds no appliance of the site.
    expect(await pulled()).not.toContain(id)

    const job = await post(
      '/jobs',
      {
        customerId: customer,
        siteId: site,
        kind: 'service',
        status: 'active',
        designation: 'Geräte prüfen',
      },
      office,
    )

    await http()
      .put(`/jobs/${job}/assignees`)
      .set('x-test-identity', office)
      .send({ userIds: ['max'] })
      .expect(200)

    expect(await pulled()).toContain(id)
  })
})

describe('the test of an appliance after DGUV Vorschrift 3', () => {
  it('hangs on the appliance and is signed there', async () => {
    const appliance = newId<'appliance'>()
    const id = newId<'form-record'>()
    const technician = as(north.id, 'technician')
    const before = complete({ protective_conductor: 650 })

    await push(app, technician, [anAppliance(appliance)])

    const { receipts } = await push(app, technician, [
      aTest(id, { applianceId: appliance }, before),
      signed(id, before, complete({ protective_conductor: 650, tester_signature: signature })),
    ])

    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['applied', 'applied'])
  })

  it('is refused at an installation, and a protocol of an installation at an appliance', async () => {
    const appliance = newId<'appliance'>()
    const technician = as(north.id, 'technician')

    await push(app, technician, [anAppliance(appliance)])

    const atInstallation = await push(
      app,
      technician,
      [aTest(newId<'form-record'>(), { installationId: installation })],
      400,
    )
    const atAppliance = await push(
      app,
      technician,
      [
        created('form_records', newId<'form-record'>(), {
          definitionKey: 'vde-0105-100',
          definitionVersion: 1,
          applianceId: appliance,
          performedOn: '2026-11-02',
          status: 'draft',
          values: '{}',
        } as never),
      ],
      400,
    )

    expect(atInstallation.message).toBe('Dieses Formular gehört an ein Gerät.')
    expect(atAppliance.message).toBe('Dieses Formular gehört an eine Anlage.')
  })

  it('hangs on exactly one of an installation and an appliance, whichever way it comes', async () => {
    const appliance = newId<'appliance'>()

    await push(app, as(north.id, 'office'), [anAppliance(appliance)])

    expect(
      await refusedBy(
        admin.query(
          `insert into form_records (tenant_id, definition_key, definition_version, installation_id, appliance_id, performed_on)
         values ($1, 'dguv-v3', 1, $2, $3, '2026-11-02')`,
          [north.id, installation, appliance],
        ),
      ),
    ).toEqual({ code: checkViolation, constraint: 'form_records_one_subject' })
    expect(
      await refusedBy(
        admin.query(
          `insert into form_records (tenant_id, definition_key, definition_version, performed_on)
         values ($1, 'dguv-v3', 1, '2026-11-02')`,
          [north.id],
        ),
      ),
    ).toEqual({ code: checkViolation, constraint: 'form_records_one_subject' })
  })

  it('prints its values judged by the limits worked out of the appliance', async () => {
    const appliance = newId<'appliance'>()
    const id = newId<'form-record'>()
    const technician = as(north.id, 'technician')
    const values = complete({ protective_conductor: 650 })

    await push(app, technician, [
      anAppliance(appliance),
      aTest(id, { applianceId: appliance }, values),
    ])
    await http()
      .get(`/form-records/${id}/pdf`)
      .set('x-test-identity', as(north.id, 'office'))
      .buffer(true)
      .parse(binary)
      .expect(200)

    const html = jobs.at(-1)?.html ?? ''

    expect(html).toContain('<h1>Prüfprotokoll Geräteprüfung nach DGUV Vorschrift 3</h1>')
    expect(html).toContain(
      '002 Verlängerungsleitung 25 m, Schutzklasse I, Anschlussleitung 25 m, Rheinstraße 12',
    )
    // 0,3 Ω up to 5 m and 0,1 Ω for each of the three lengths of 7,5 m begun beyond.
    expect(html).toContain('0,65 Ω <span class="outside">außerhalb des Grenzwerts</span>')
    expect(html).toContain('höchstens 0,60 Ω; DGUV Information 203-070')
  })
})

describe('the report of a site after DGUV Vorschrift 3', () => {
  it('lists every appliance with its last signed test, the untested ones too', async () => {
    // A site of its own, so that the appliances of the other tests stay out.
    const office = as(north.id, 'office')
    const technician = as(north.id, 'technician')
    const yard = await post(
      '/sites',
      {
        customerId: customer,
        designation: 'Bauhof',
        street: 'Hafenstraße',
        houseNumber: '2',
        postalCode: '68159',
        city: 'Mannheim',
      },
      office,
    )
    const drill = newId<'appliance'>()
    const heater = newId<'appliance'>()
    const drum = newId<'appliance'>()
    const older = newId<'form-record'>()
    const newer = newId<'form-record'>()
    const defect = newId<'form-record'>()
    const draft = newId<'form-record'>()
    const first = complete({ next_inspection_months: 6_000 })
    const second = complete()
    const found = complete({ verdict: 'defects', defects: 'Leitung beschädigt.', cord: 'defect' })

    await push(app, technician, [
      anAppliance(drill, {
        siteId: yard,
        inventoryNumber: '10',
        designation: 'Bohrhammer',
        protectionClass: 'II',
        cordLengthMilli: null,
      }),
      anAppliance(heater, {
        siteId: yard,
        inventoryNumber: '9',
        designation: 'Heizlüfter',
        cordLengthMilli: null,
      }),
      anAppliance(drum, { siteId: yard, inventoryNumber: null, designation: 'Kabeltrommel 50 m' }),
      aTest(older, { applianceId: drill }, first, '2026-01-10'),
      signed(
        older,
        first,
        complete({ next_inspection_months: 6_000, tester_signature: signature }),
      ),
      aTest(newer, { applianceId: drill }, second),
      signed(newer, second, complete({ tester_signature: signature })),
      aTest(defect, { applianceId: heater }, found),
      signed(
        defect,
        found,
        complete({
          verdict: 'defects',
          defects: 'Leitung beschädigt.',
          cord: 'defect',
          tester_signature: signature,
        }),
      ),
      // A draft is no test anybody vouched for.
      aTest(draft, { applianceId: drum }),
    ])

    await http()
      .get(`/sites/${yard}/appliance-report`)
      .set('x-test-identity', office)
      .buffer(true)
      .parse(binary)
      .expect(200)

    const html = jobs.at(-1)?.html ?? ''
    const rows = [...html.matchAll(/<td class="number">([^<]*)<\/td>/g)].map((match) => match[1])

    expect(html).toContain('<h1>Prüfbericht nach DGUV Vorschrift 3</h1>')
    expect(html).toContain('Bauhof, Hafenstraße 2, 68159 Mannheim, für Hausverwaltung Süd GmbH')
    // As a person counts: 9 before 10, and one without a number last.
    expect(rows).toEqual(['9', '10', ''])
    // The newest signed test of the drill, a year from the 2nd of November.
    expect(html).toContain('02.11.2027')
    expect(html).not.toContain('10.07.2026')
    expect(html).toContain('<span class="outside">Mängel festgestellt</span>')
    expect(html).toContain('<span class="untested">noch nicht geprüft</span>')
    expect(html).toContain('3 Geräte: 1 ohne Mängel, 1 mit Mängeln, 1 noch nicht geprüft.')
  })

  it('is not found for a site of another business, nor for one that is not there', async () => {
    const theirs = await post(
      '/customers',
      { kind: 'business', name: 'Süd' },
      as(south.id, 'office'),
    )
    const theirSite = await post(
      '/sites',
      {
        customerId: theirs,
        designation: 'Süd 1',
        street: 'Weg',
        houseNumber: '1',
        postalCode: '68159',
        city: 'Mannheim',
      },
      as(south.id, 'office'),
    )

    await http()
      .get(`/sites/${theirSite}/appliance-report`)
      .set('x-test-identity', as(north.id, 'office'))
      .expect(404)
    await http()
      .get(`/sites/${newId<'site'>()}/appliance-report`)
      .set('x-test-identity', as(north.id, 'office'))
      .expect(404)
  })
})

/** Bytes of a photo; the store keeps whatever it is given under its hash. */
function photoBytes(label: string): Buffer {
  return Buffer.from(`PNG ${label}`)
}

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function upload(bytes: Buffer, who: string): Promise<void> {
  await http()
    .put(`/files/${hashOf(bytes)}`)
    .set('x-test-identity', who)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Media-Type', 'image/png')
    .send(bytes)
    .expect(200)
}

/** A new version of a file, as a device sends it. */
function aVersion(attachment: string, bytes: Buffer) {
  return created('attachment_versions', newId<'attachment-version'>(), {
    attachmentId: attachment,
    sha256: hashOf(bytes),
    fileName: 'leitung.png',
    mediaType: 'image/png',
    sizeBytes: bytes.byteLength,
  })
}

/** The page of a protocol as the renderer got it. */
async function printed(id: string, who: string): Promise<string> {
  await http()
    .get(`/form-records/${id}/pdf`)
    .set('x-test-identity', who)
    .buffer(true)
    .parse(binary)
    .expect(200)

  return jobs.at(-1)?.html ?? ''
}

/** A test in version 2 of the form, which has a photo (#817). */
function aPhotoTest(id: string, appliance: string, values: string) {
  return created('form_records', id, {
    definitionKey: 'dguv-v3',
    definitionVersion: 2,
    performedOn: '2026-11-02',
    status: 'draft',
    values,
    applianceId: appliance,
  } as never)
}

describe('the files of an appliance (#817)', () => {
  it('hang on the appliance alone and reach a device with the site of its job', async () => {
    const technician = person('max', 'technician')
    const office = as(north.id, 'office')
    const elsewhere = await post(
      '/sites',
      { customerId: customer, designation: 'Lagerhalle', city: 'Mannheim' },
      office,
    )
    const here = newId<'appliance'>()
    const there = newId<'appliance'>()
    const atHere = newId<'attachment'>()
    const atThere = newId<'attachment'>()

    await push(app, office, [
      anAppliance(here, { inventoryNumber: '011', designation: 'Heizlüfter' }),
      anAppliance(there, { siteId: elsewhere, inventoryNumber: '012', designation: 'Kreissäge' }),
    ])

    const { receipts } = await push(app, office, [
      created('attachments', atHere, { applianceId: here, title: 'Anschlussleitung' }),
      created('attachments', atThere, { applianceId: there, title: 'Typenschild' }),
    ])

    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['applied', 'applied'])

    const job = await post(
      '/jobs',
      {
        customerId: customer,
        siteId: site,
        kind: 'service',
        status: 'active',
        designation: 'Heizlüfter prüfen',
      },
      office,
    )

    await http()
      .put(`/jobs/${job}/assignees`)
      .set('x-test-identity', office)
      .send({ userIds: ['max'] })
      .expect(200)

    const answer = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)
    const files =
      (answer.body as { changes: { entity: string; rows: { id: string }[] }[] }).changes
        .find((change) => change.entity === 'attachments')
        ?.rows.map((row) => row.id) ?? []

    expect(files).toContain(atHere)
    expect(files).not.toContain(atThere)

    // The appliance from elsewhere moves onto the site of the job: its file
    // lies behind the cursor of the device, which the value makes it drop
    // and ask again for (opengewerk#938).
    const narrowed = (body: unknown) =>
      (body as { narrowed: Record<string, string> }).narrowed['attachments']
    const before = narrowed(answer.body)

    await push(app, office, [
      changed('appliances', there, { siteId: { from: elsewhere, to: site } }),
    ])

    const after = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)
    const moved =
      (after.body as { changes: { entity: string; rows: { id: string }[] }[] }).changes
        .find((change) => change.entity === 'attachments')
        ?.rows.map((row) => row.id) ?? []

    expect(narrowed(after.body)).not.toBe(before)
    expect(moved).toContain(atThere)

    // The one moves away and another moves in instead: as many moves as
    // before, and still a different value.
    const third = newId<'appliance'>()
    const atThird = newId<'attachment'>()

    await push(app, office, [
      anAppliance(third, {
        siteId: elsewhere,
        inventoryNumber: '014',
        designation: 'Bohrmaschine',
      }),
    ])
    await push(app, office, [
      created('attachments', atThird, { applianceId: third, title: 'Prüfplakette' }),
    ])
    await push(app, office, [
      changed('appliances', there, { siteId: { from: site, to: elsewhere } }),
      changed('appliances', third, { siteId: { from: elsewhere, to: site } }),
    ])

    const swapped = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)

    expect(narrowed(swapped.body)).not.toBe(narrowed(after.body))

    // A new appliance at the site moves nothing, and the value stays.
    await push(app, office, [
      anAppliance(newId<'appliance'>(), { inventoryNumber: '013', designation: 'Wasserkocher' }),
    ])

    const again = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)

    expect(narrowed(again.body)).toBe(narrowed(swapped.body))
  })

  it('reach a device with an installation that moves onto the site of its job (opengewerk#938)', async () => {
    const technician = person('max', 'technician')
    const office = as(north.id, 'office')
    const elsewhere = await post(
      '/sites',
      { customerId: customer, designation: 'Werkhalle', city: 'Mannheim' },
      office,
    )
    const board = await post(
      '/installations',
      { siteId: elsewhere, kind: 'meter_cabinet', designation: 'Unterverteiler Halle' },
      office,
    )
    const plan = newId<'attachment'>()

    await push(app, office, [
      created('attachments', plan, { installationId: board, title: 'Stromlaufplan' }),
    ])

    const job = await post(
      '/jobs',
      {
        customerId: customer,
        siteId: site,
        kind: 'service',
        status: 'active',
        designation: 'Unterverteiler prüfen',
      },
      office,
    )

    await http()
      .put(`/jobs/${job}/assignees`)
      .set('x-test-identity', office)
      .send({ userIds: ['max'] })
      .expect(200)

    const narrowed = (body: unknown) =>
      (body as { narrowed: Record<string, string> }).narrowed['attachments']
    const before = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)

    await push(app, office, [
      changed('installations', board, { siteId: { from: elsewhere, to: site } }),
    ])

    const after = await http().get('/sync?since=0').set('x-test-identity', technician).expect(200)

    expect(narrowed(after.body)).not.toBe(narrowed(before.body))
  })

  it('are a home of a file in the database, and a file with none is refused', async () => {
    const appliance = newId<'appliance'>()

    await push(app, as(north.id, 'office'), [anAppliance(appliance)])
    await admin.query(
      "insert into attachments (tenant_id, appliance_id, title) values ($1, $2, 'Typenschild')",
      [north.id, appliance],
    )

    expect(
      await refusedBy(
        admin.query("insert into attachments (tenant_id, title) values ($1, 'Nirgends')", [
          north.id,
        ]),
      ),
    ).toEqual({ code: checkViolation, constraint: 'attachments_have_a_home' })
  })

  it('give a protocol its photo, the version of the day it was signed', async () => {
    const technician = as(north.id, 'technician')
    const office = as(north.id, 'office')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const [first, second, third] = [photoBytes('eins'), photoBytes('zwei'), photoBytes('drei')]
    const base64 = (bytes: Buffer) => bytes.toString('base64')
    const before = complete({ photo })

    for (const bytes of [first, second, third]) {
      await upload(bytes, technician)
    }

    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, {
        applianceId: appliance,
        siteId: site,
        title: 'Anschlussleitung',
      }),
      aVersion(photo, first),
      aPhotoTest(id, appliance, before),
    ])

    const draft = await printed(id, office)

    expect(draft).toContain(`data:image/png;base64,${base64(first)}`)
    expect(draft).toContain('<figcaption>leitung.png</figcaption>')

    // A draft shows the newest version.
    await push(app, technician, [aVersion(photo, second)])
    expect(await printed(id, office)).toContain(base64(second))

    // Signed, and a version laid over the photo after it in the same
    // transmission, as a device that was offline sends both.
    await push(app, technician, [
      signed(id, before, complete({ photo, tester_signature: signature })),
      aVersion(photo, third),
    ])

    const sealed = await printed(id, office)

    expect(sealed).toContain(base64(second))
    expect(sealed).not.toContain(base64(third))

    // Renamed after the signature: the page stays as it was signed. Hung
    // elsewhere it is not any more (opengewerk#934).
    const { receipts } = await push(app, office, [
      changed('attachments', photo, {
        title: { from: 'Anschlussleitung', to: 'Alles in Ordnung' },
      }),
    ])

    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['applied'])

    const moved = await printed(id, office)

    expect(moved).toContain(base64(second))
    expect(moved).toContain('<figcaption>leitung.png</figcaption>')
    expect(moved).not.toContain('Alles in Ordnung')
  })

  it('give a protocol no photo of something else, nor to whoever may not see the files', async () => {
    const technician = as(north.id, 'technician')
    const office = as(north.id, 'office')
    const appliance = newId<'appliance'>()
    const ofInstallation = newId<'attachment'>()
    const own = newId<'attachment'>()
    const foreign = newId<'form-record'>()
    const mine = newId<'form-record'>()
    const [plan, cord] = [photoBytes('Plan der Anlage'), photoBytes('Leitung')]

    await upload(plan, technician)
    await upload(cord, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', ofInstallation, { installationId: installation, title: 'Plan' }),
      aVersion(ofInstallation, plan),
      created('attachments', own, { applianceId: appliance, title: 'Leitung' }),
      aVersion(own, cord),
      aPhotoTest(foreign, appliance, complete({ photo: ofInstallation })),
      aPhotoTest(mine, appliance, complete({ photo: own })),
    ])

    const other = await printed(foreign, office)

    expect(other).not.toContain(plan.toString('base64'))
    expect(other).toContain('bei den Dateien des Geräts')

    const officeRole = shippedRoles.filter((role) => role.key === 'office')
    const rights = permissionCatalogue.sumOf(officeRole).rights
    const withoutFiles = JSON.stringify({
      userId: 'lena',
      tenantId: north.id,
      roles: [],
      rights: rights.filter((right) => right !== 'attachment.read'),
    })

    expect(await printed(mine, office)).toContain(cord.toString('base64'))

    const unseen = await printed(mine, withoutFiles)

    expect(unseen).not.toContain(cord.toString('base64'))
    expect(unseen).toContain('bei den Dateien des Geräts')
  })
})

describe('the photo a protocol is signed with (#934)', () => {
  it('hangs at what it tests, or the signature is refused for this protocol alone', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const ofInstallation = newId<'attachment'>()
    const own = newId<'attachment'>()
    const [elsewhere, missing, right] = [
      newId<'form-record'>(),
      newId<'form-record'>(),
      newId<'form-record'>(),
    ]
    const plan = photoBytes('Plan, signiert')

    await upload(plan, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', ofInstallation, { installationId: installation, title: 'Plan' }),
      aVersion(ofInstallation, plan),
      created('attachments', own, { applianceId: appliance, title: 'Leitung' }),
      aVersion(own, plan),
    ])

    const draftAndSign = async (id: string, photo: string) => {
      const before = complete({ photo })

      await push(app, technician, [aPhotoTest(id, appliance, before)])

      return push(app, technician, [
        signed(id, before, complete({ photo, tester_signature: signature })),
      ])
    }
    const statusOf = async (id: string) =>
      (await admin.query<{ status: string }>('select status from form_records where id = $1', [id]))
        .rows[0]?.status

    const foreign = await draftAndSign(elsewhere, ofInstallation)

    expect(foreign.receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ['conflict', 'changed_elsewhere'],
    ])
    expect(await statusOf(elsewhere)).toBe('draft')

    const nowhere = await draftAndSign(missing, newId<'attachment'>())

    expect(nowhere.receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ['conflict', 'record_missing'],
    ])
    expect(await statusOf(missing)).toBe('draft')

    // A file the office put in the bin meanwhile: the page would leave it out.
    const binned = newId<'attachment'>()
    const late = newId<'form-record'>()

    await push(app, technician, [
      created('attachments', binned, { applianceId: appliance, title: 'Weg' }),
      aVersion(binned, plan),
    ])
    await push(app, as(north.id, 'office'), [deleted('attachments', binned)])

    const gone = await draftAndSign(late, binned)

    expect(gone.receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ['conflict', 'record_missing'],
    ])
    expect(await statusOf(late)).toBe('draft')

    const fitting = await draftAndSign(right, own)

    expect(fitting.receipts.map(({ outcome }) => outcome)).toEqual(['applied'])
    expect(await statusOf(right)).toBe('signed')
  })

  it('stays where it hangs once a signed protocol names it, while a draft lets it go', async () => {
    const technician = as(north.id, 'technician')
    const office = as(north.id, 'office')
    const appliance = newId<'appliance'>()
    const other = newId<'appliance'>()
    const sealedPhoto = newId<'attachment'>()
    const draftPhoto = newId<'attachment'>()
    const sealed = newId<'form-record'>()
    const draft = newId<'form-record'>()
    const cord = photoBytes('Leitung, bleibt')
    const before = complete({ photo: sealedPhoto })

    await upload(cord, technician)
    await push(app, technician, [
      anAppliance(appliance),
      anAppliance(other, { inventoryNumber: '098' }),
      created('attachments', sealedPhoto, { applianceId: appliance, title: 'Leitung' }),
      aVersion(sealedPhoto, cord),
      created('attachments', draftPhoto, { applianceId: appliance, title: 'Stecker' }),
      aVersion(draftPhoto, cord),
      aPhotoTest(sealed, appliance, before),
      aPhotoTest(draft, appliance, complete({ photo: draftPhoto })),
    ])
    await push(app, technician, [
      signed(sealed, before, complete({ photo: sealedPhoto, tester_signature: signature })),
    ])

    const move = (photo: string) =>
      changed('attachments', photo, { applianceId: { from: appliance, to: other } })
    const kept = await push(app, office, [move(sealedPhoto)], 409)

    expect(kept.message).toBe(
      'Diese Datei ist das Foto eines unterschriebenen Protokolls und bleibt, wo sie hängt.',
    )

    const gone = await push(app, office, [move(draftPhoto)])

    expect(gone.receipts.map(({ outcome }) => outcome)).toEqual(['applied'])

    const { rows } = await admin.query<{ id: string; appliance_id: string }>(
      'select id, appliance_id from attachments where id = any($1)',
      [[sealedPhoto, draftPhoto]],
    )

    expect(Object.fromEntries(rows.map((row) => [row.id, row.appliance_id]))).toEqual({
      [sealedPhoto]: appliance,
      [draftPhoto]: other,
    })
  })

  it('sees a move of its file that is still open, once it is through', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const other = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const before = complete({ photo })

    await push(app, technician, [
      anAppliance(appliance),
      anAppliance(other, { inventoryNumber: '096' }),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
      aPhotoTest(id, appliance, before),
    ])

    const moving = await admin.connect()
    let signing: ReturnType<typeof push> = Promise.resolve({ receipts: [] })

    try {
      // The office moves the file and has not committed yet.
      await moving.query('begin')
      await moving.query("select set_config('app.tenant_id', $1, true)", [north.id])
      await moving.query("select set_config('app.user_id', 'lena', true)")
      await moving.query('update attachments set appliance_id = $1 where id = $2', [other, photo])

      signing = push(app, technician, [
        signed(id, before, complete({ photo, tester_signature: signature })),
      ])
      await waitingFor(admin, moving, signing)
      await moving.query('commit')

      const { receipts } = await signing

      expect(receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
        ['conflict', 'changed_elsewhere'],
      ])
    } finally {
      await moving.query('rollback').catch(() => undefined)
      await signing.catch(() => undefined)
      moving.release()
    }
  })

  it('waits for a writer of the draft that holds its row, and does not wait in a circle', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const before = complete({ photo })

    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
      aPhotoTest(id, appliance, before),
    ])

    const editing = await admin.connect()
    let signing: ReturnType<typeof push> = Promise.resolve({ receipts: [] })

    try {
      // Another writer holds the row of the draft and changes it after.
      await editing.query('begin')
      await editing.query("select set_config('app.tenant_id', $1, true)", [north.id])
      await editing.query("select set_config('app.user_id', 'lena', true)")
      await editing.query('select id from form_records where id = $1 for no key update', [id])

      signing = push(app, technician, [
        signed(id, before, complete({ photo, tester_signature: signature })),
      ])
      await waitingFor(admin, editing, signing)
      await editing.query("update form_records set performed_on = '2026-11-03' where id = $1", [id])
      await editing.query('commit')

      const { receipts } = await signing

      expect(receipts.map(({ outcome }) => outcome)).toEqual(['applied'])
    } finally {
      await editing.query('rollback').catch(() => undefined)
      await signing.catch(() => undefined)
      editing.release()
    }
  })

  it('asks the draft as a writer that held its row left it', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const other = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const before = complete({ photo })

    await push(app, technician, [
      anAppliance(appliance),
      anAppliance(other, { inventoryNumber: '095' }),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
      aPhotoTest(id, appliance, before),
    ])

    const editing = await admin.connect()
    let signing: ReturnType<typeof push> = Promise.resolve({ receipts: [] })

    try {
      // Another writer holds the row and hangs the draft on another
      // appliance, whose files the photo is not among.
      await editing.query('begin')
      await editing.query("select set_config('app.tenant_id', $1, true)", [north.id])
      await editing.query("select set_config('app.user_id', 'lena', true)")
      await editing.query('select id from form_records where id = $1 for no key update', [id])

      signing = push(app, technician, [
        signed(id, before, complete({ photo, tester_signature: signature })),
      ])
      await waitingFor(admin, editing, signing)
      await editing.query('update form_records set appliance_id = $1 where id = $2', [other, id])
      await editing.query('commit')

      const { receipts } = await signing

      expect(receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
        ['conflict', 'changed_elsewhere'],
      ])
    } finally {
      await editing.query('rollback').catch(() => undefined)
      await signing.catch(() => undefined)
      editing.release()
    }
  })

  it('asks the form as a writer that held its row left it, its version included', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const ofInstallation = newId<'attachment'>()
    const id = newId<'form-record'>()
    const ready = complete({ tester_signature: signature })

    // A draft of version 1, which has no photo, ready to sign.
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', ofInstallation, { installationId: installation, title: 'Plan' }),
      created('form_records', id, {
        definitionKey: 'dguv-v3',
        definitionVersion: 1,
        performedOn: '2026-11-02',
        status: 'draft',
        values: ready,
        applianceId: appliance,
      } as never),
    ])

    const editing = await admin.connect()
    let signing: ReturnType<typeof push> = Promise.resolve({ receipts: [] })

    try {
      // Another writer holds the row and makes it version 2, with a photo
      // of something else.
      await editing.query('begin')
      await editing.query("select set_config('app.tenant_id', $1, true)", [north.id])
      await editing.query("select set_config('app.user_id', 'lena', true)")
      await editing.query('select id from form_records where id = $1 for no key update', [id])

      signing = push(app, technician, [
        changed('form_records', id, { status: { from: 'draft', to: 'signed' } }),
      ])
      await waitingFor(admin, editing, signing)
      await editing.query(
        'update form_records set definition_version = 2, "values" = $1 where id = $2',
        [complete({ photo: ofInstallation, tester_signature: signature }), id],
      )
      await editing.query('commit')

      const { receipts } = await signing

      expect(receipts.map(({ outcome, reason }) => [outcome, reason])).toEqual([
        ['conflict', 'changed_elsewhere'],
      ])
    } finally {
      await editing.query('rollback').catch(() => undefined)
      await signing.catch(() => undefined)
      editing.release()
    }
  })

  it('is named in small letters and spelt out, or the signature is refused', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const cord = photoBytes('Leitung, anders geschrieben')

    await upload(cord, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
      aVersion(photo, cord),
    ])

    // In capitals, and with its first digit as an escape: the same id to the
    // check, another text to the trigger.
    for (const spelt of [
      `"photo":"${photo.toUpperCase()}"`,
      `"photo":"\\u00${photo.charCodeAt(0).toString(16)}${photo.slice(1)}"`,
    ]) {
      const id = newId<'form-record'>()
      const values = (signer: boolean) =>
        complete({ photo: 'x', ...(signer ? { tester_signature: signature } : {}) }).replace(
          '"photo":"x"',
          spelt,
        )

      await push(app, technician, [aPhotoTest(id, appliance, values(false))])

      const refused = await push(app, technician, [signed(id, values(false), values(true))], 400)

      expect(refused.message).toBe(
        'Ein Foto nennt die Kennung seiner Datei in Kleinbuchstaben und ausgeschrieben.',
      )
    }
  })

  it('stays where it hangs where one signed before names it in capitals', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const other = newId<'appliance'>()
    const photo = newId<'attachment'>()

    await push(app, technician, [
      anAppliance(appliance),
      anAppliance(other, { inventoryNumber: '097' }),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
    ])
    // Written before the sync asked how, as the database holds it.
    await admin.query(
      `insert into form_records (tenant_id, definition_key, definition_version, appliance_id, performed_on, status, "values")
       values ($1, 'dguv-v3', 2, $2, '2026-11-02', 'signed', $3)`,
      [north.id, appliance, complete({ photo: photo.toUpperCase(), tester_signature: signature })],
    )

    await push(
      app,
      as(north.id, 'office'),
      [changed('attachments', photo, { applianceId: { from: appliance, to: other } })],
      409,
    )
  })

  it('is left out of the page where one signed before named a file of something else', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const ofInstallation = newId<'attachment'>()
    const id = newId<'form-record'>()
    const plan = photoBytes('Plan, fremd')

    await upload(plan, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', ofInstallation, { installationId: installation, title: 'Plan' }),
      aVersion(ofInstallation, plan),
    ])
    // Written before the sync asked, as the database holds it.
    await admin.query(
      `insert into form_records (id, tenant_id, definition_key, definition_version, appliance_id, performed_on, status, "values")
       values ($1, $2, 'dguv-v3', 2, $3, '2026-11-02', 'signed', $4)`,
      [id, north.id, appliance, complete({ photo: ofInstallation, tester_signature: signature })],
    )

    const page = await printed(id, as(north.id, 'office'))

    expect(page).not.toContain(plan.toString('base64'))
    expect(page).toContain('bei den Dateien des Geräts')
  })
})

describe('the photo of a signed protocol (#817)', () => {
  it('stays when its file goes to the bin, while a draft leaves it', async () => {
    const technician = as(north.id, 'technician')
    const office = as(north.id, 'office')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const sealed = newId<'form-record'>()
    const draft = newId<'form-record'>()
    const [first, second, third] = [photoBytes('alt'), photoBytes('mitte'), photoBytes('neu')]
    const before = complete({ photo })

    for (const bytes of [first, second, third]) {
      await upload(bytes, technician)
    }

    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Stecker' }),
      aVersion(photo, first),
      aPhotoTest(sealed, appliance, before),
      aPhotoTest(draft, appliance, before),
    ])
    // Two versions in one transmission share their moment; the later one is the newest.
    await push(app, technician, [aVersion(photo, second), aVersion(photo, third)])
    expect(await printed(draft, office)).toContain(third.toString('base64'))

    await push(app, technician, [
      signed(sealed, before, complete({ photo, tester_signature: signature })),
    ])
    await admin.query('update attachments set deleted_at = now() where id = $1', [photo])

    expect(await printed(sealed, office)).toContain(third.toString('base64'))

    const left = await printed(draft, office)

    expect(left).not.toContain(third.toString('base64'))
    expect(left).toContain('bei den Dateien des Geräts')
  })

  it('shows no photo that lay in the bin before it was signed', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const bytes = photoBytes('vorher entfernt')
    const before = complete({ photo })

    await upload(bytes, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Zuleitung' }),
      aVersion(photo, bytes),
      aPhotoTest(id, appliance, before),
    ])
    await admin.query(
      "update attachments set deleted_at = now() - interval '1 minute' where id = $1",
      [photo],
    )
    await push(app, technician, [
      signed(id, before, complete({ photo, tester_signature: signature })),
    ])

    const page = await printed(id, as(north.id, 'office'))

    expect(page).not.toContain(bytes.toString('base64'))
    expect(page).toContain('bei den Dateien des Geräts')
  })
})

describe('a photo field that names no file (#817)', () => {
  it('prints where the photo lies instead of refusing the protocol', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const id = newId<'form-record'>()

    await push(app, technician, [anAppliance(appliance)])

    // A device can send no such value any more (#933) ...
    const refused = await push(
      app,
      technician,
      [aPhotoTest(id, appliance, complete({ photo: 'foto-1' }))],
      400,
    )

    expect(refused.message).toContain('ein Foto aus den Dateien.')

    // ... but one signed before stays as it was written.
    await admin.query(
      `insert into form_records (id, tenant_id, definition_key, definition_version, appliance_id, performed_on, status, "values")
       values ($1, $2, 'dguv-v3', 2, $3, '2026-11-02', 'signed', $4)`,
      [id, north.id, appliance, complete({ photo: 'foto-1', tester_signature: signature })],
    )

    expect(await printed(id, as(north.id, 'office'))).toContain('bei den Dateien des Geräts')
  })
})

describe('the newest version of a photo (#817)', () => {
  it('is the newest by id, as every list of files shows it, whenever the server wrote it', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    // Made offline at 09:30 and sent at 11:00, after one made at 10:00.
    const earlier = newId<'attachment-version'>()
    const later = newId<'attachment-version'>()
    const [first, second] = [photoBytes('09:30'), photoBytes('10:00')]
    const version = (versionId: string, bytes: Buffer) =>
      created('attachment_versions', versionId, {
        attachmentId: photo,
        sha256: hashOf(bytes),
        fileName: 'leitung.png',
        mediaType: 'image/png',
        sizeBytes: bytes.byteLength,
      })

    await upload(first, technician)
    await upload(second, technician)
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Leitung' }),
      version(later, second),
      aPhotoTest(id, appliance, complete({ photo })),
    ])
    await push(app, technician, [version(earlier, first)])

    const page = await printed(id, as(north.id, 'office'))

    expect(page).toContain(second.toString('base64'))
    expect(page).not.toContain(first.toString('base64'))
  })
})

describe('the photos one page of a protocol reads (#817)', () => {
  const version = (id: string, sizeBytes: number, mediaType = 'image/jpeg') => ({
    id,
    fileName: `${id}.jpg`,
    mediaType,
    sha256: id,
    sizeBytes,
    changeSequence: 1,
  })
  const read = (versions: ReturnType<typeof version>[], uses = new Map<string, number>()) =>
    photosToRead(new Map(versions.map((each) => [each.id, each])), uses, {
      count: 2,
      bytes: 100,
    }).map(([id]) => id)

  it('are pictures alone, and no more than the bound in number', () => {
    expect(
      read([
        version('a', 10),
        version('b', 10, 'application/pdf'),
        version('c', 10),
        version('d', 10),
      ]),
    ).toEqual(['a', 'c'])
  })

  it('count a photo once for every field that names it, as the page prints it', () => {
    // Named twice, 60 bytes are 120 and past the bound; and two in number.
    expect(read([version('a', 60), version('b', 10)], new Map([['a', 2]]))).toEqual(['b'])
    expect(read([version('a', 10), version('b', 10)], new Map([['a', 2]]))).toEqual(['a'])
  })

  it('take only what a large page leaves of one request to the renderer', () => {
    for (const page of [0, 1_000_000, 5_000_000, 9_000_000, 10_400_000, 20_000_000]) {
      const { bytes } = photoBound(page)

      expect(bytes).toBeGreaterThanOrEqual(0)
      expect(bytes).toBeLessThanOrEqual(printedPhotos.bytes)
      // A page that is too large on its own gets no photo, and no more than it had.
      if (bytes > 0) {
        expect(Math.ceil((bytes * 4) / 3) + page).toBeLessThan(rendererRequestBytes)
      }
    }

    expect(photoBound(1_000_000).bytes).toBe(printedPhotos.bytes)
    expect(photoBound(20_000_000).bytes).toBe(0)
  })

  it('fit, as base64 and with room for the page, into one request to the renderer', () => {
    expect(Math.ceil((printedPhotos.bytes * 4) / 3) + 2_000_000).toBeLessThanOrEqual(
      rendererRequestBytes,
    )
  })

  it('stay within the bound in bytes, a large one left to say where it lies', () => {
    expect(read([version('a', 60), version('b', 60), version('c', 40)])).toEqual(['a', 'c'])
  })
})

describe('a photo with no version at its signature (#817)', () => {
  it('stays away from the page of a signed protocol, whatever is written later', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const later = photoBytes('nach der Unterschrift')
    const before = complete({ photo })

    await upload(later, technician)
    // The file is there to sign with (opengewerk#934), its first version comes
    // after the signature.
    await push(app, technician, [
      anAppliance(appliance),
      created('attachments', photo, { applianceId: appliance, title: 'Später' }),
      aPhotoTest(id, appliance, before),
    ])
    await push(app, technician, [
      signed(id, before, complete({ photo, tester_signature: signature })),
    ])
    await push(app, technician, [aVersion(photo, later)])

    const page = await printed(id, as(north.id, 'office'))

    expect(page).not.toContain(later.toString('base64'))
    expect(page).toContain('bei den Dateien des Geräts')
  })
})

describe('a photo whose stored file is gone (#817)', () => {
  it('says where the photo lies, and the page is printed all the same', async () => {
    const technician = as(north.id, 'technician')
    const appliance = newId<'appliance'>()
    const photo = newId<'attachment'>()
    const id = newId<'form-record'>()
    const sha = 'd'.repeat(64)

    await push(app, technician, [anAppliance(appliance)])
    // A version whose bytes never reached the store of this installation.
    await admin.query(
      `begin; set local session_replication_role = replica;
       insert into files (tenant_id, sha256, size_bytes, media_type) values ($1, $2, 10, 'image/png');
       insert into attachments (id, tenant_id, appliance_id, title) values ($3, $1, $4, 'Verloren');
       insert into attachment_versions (tenant_id, attachment_id, sha256, file_name, media_type, size_bytes)
         values ($1, $3, $2, 'verloren.png', 'image/png', 10);
       commit;`
        .replaceAll('$1', `'${north.id}'`)
        .replaceAll('$2', `'${sha}'`)
        .replaceAll('$3', `'${photo}'`)
        .replaceAll('$4', `'${appliance}'`),
    )
    await push(app, technician, [aPhotoTest(id, appliance, complete({ photo }))])

    expect(await printed(id, as(north.id, 'office'))).toContain('bei den Dateien des Geräts')
  })
})

describe('the versions of a photo (#817)', () => {
  it('are grouped in time that grows with their number', () => {
    const rows = Array.from({ length: 50_000 }, (_, index) => ({
      id: 'f-1',
      fileName: 'leitung.jpg',
      mediaType: 'image/jpeg',
      sha256: String(index),
      sizeBytes: 10,
      changeSequence: 50_000 - index,
    }))
    const started = performance.now()

    expect(shownVersions(rows, 5)?.get('f-1')?.changeSequence).toBe(5)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
