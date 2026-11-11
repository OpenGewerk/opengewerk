import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { peopleSchema } from './people.js'
import { qualificationSchema } from './qualifications.js'

// The tables of the qualifications as an application makes them (ADR 0012),
// asked of the tables and of no database. What a database makes of them, the
// tests of the application that binds them hold.

const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((column) => column.name)

describe('the tables of the qualifications', () => {
  it('travel: both carry the columns of the sync, and keep the tenants apart', () => {
    const travelling = ['version', 'updated_by', 'device_id', 'deleted_at', 'change_sequence']
    const { qualificationKinds, qualifications } = qualificationSchema(peopleSchema())

    for (const table of [qualificationKinds, qualifications]) {
      expect(columnsOf(table)).toEqual(expect.arrayContaining(travelling))
      expect(getTableConfig(table).policies.map((policy) => policy.name)).toContain(
        'tenant_isolation',
      )
    }
  })

  it('hold in the database that a qualification is of somebody here, of exactly one kind, with a stored certificate', () => {
    const { qualifications, qualificationKinds } = qualificationSchema(peopleSchema())

    expect(getTableConfig(qualifications).foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        'qualifications_of_somebody_here',
        'qualifications_of_an_own_kind',
        'qualifications_certificate_stored',
      ]),
    )
    expect(getTableConfig(qualifications).checks.map((each) => each.name)).toEqual(
      expect.arrayContaining([
        'qualifications_one_kind',
        'qualifications_certificate_is_a_hash',
        'qualifications_certificate_named',
        'qualifications_certificate_name_fits',
      ]),
    )
    expect(getTableConfig(qualificationKinds).checks.map((each) => each.name)).toEqual(
      expect.arrayContaining(['qualification_kinds_level_known']),
    )
    expect(columnsOf(qualifications)).toEqual(
      expect.arrayContaining([
        'person_id',
        'kind_key',
        'own_kind_id',
        'valid_until',
        'certificate_sha256',
        'certificate_name',
      ]),
    )
  })

  // The certificates a qualification named before (opengewerk#802) stay on
  // the server: no columns of the sync, a stored file of this tenant, of a
  // qualification and a person here.
  it('keep a certificate of before by its file, of a qualification and a person here, without travelling', () => {
    const { replacedCertificates } = qualificationSchema(peopleSchema())
    const config = getTableConfig(replacedCertificates)

    expect(config.policies.map((policy) => policy.name)).toContain('tenant_isolation')
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        'replaced_certificates_of_somebody_here',
        'replaced_certificates_of_a_qualification_here',
        'replaced_certificates_stored',
      ]),
    )
    expect(config.checks.map((each) => each.name)).toEqual(
      expect.arrayContaining([
        'replaced_certificates_is_a_hash',
        'replaced_certificates_name_fits',
      ]),
    )
    expect(columnsOf(replacedCertificates)).not.toContain('change_sequence')
  })
})
