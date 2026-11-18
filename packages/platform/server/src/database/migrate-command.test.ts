import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ServerApplication } from '../configuration.js'
import { migrationRole } from './roles.js'
import { migrateCommand } from './migrate-command.js'

const application: ServerApplication = {
  name: 'Probewerk',
  port: 24680,
  versionVariable: 'PROBEWERK_VERSION',
  passwordVariable: 'PROBEWERK_PASSWORD',
  exampleOrigin: 'https://probewerk.example.de',
  exampleDatabase: 'probewerk',
}

// Port 1 on this machine answers nobody: a run that gets as far as the
// database fails there, with the sentence for a failed migration.
const nowhere = `postgres://${migrationRole}:geheim@127.0.0.1:1/probewerk`

describe('migrateCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('refuses an address the application refuses before it touches the database (#984)', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await migrateCommand(application, '/nowhere', {
      MIGRATION_DATABASE_URL: nowhere,
      TRUSTED_ORIGINS: 'http://werkstatt.example.org',
    })

    expect(process.exitCode).toBe(1)
    expect(said).toHaveBeenCalledTimes(1)
    expect(said).toHaveBeenCalledWith(expect.stringContaining('Über http:// gingen'))
  })

  it('goes on to the database with an address the application takes, or without one', async () => {
    for (const environment of [
      { MIGRATION_DATABASE_URL: nowhere, TRUSTED_ORIGINS: 'https://werkstatt.example.org' },
      { MIGRATION_DATABASE_URL: nowhere },
    ]) {
      const said = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      await migrateCommand(application, '/nowhere', environment)

      expect(process.exitCode).toBe(1)
      expect(said).not.toHaveBeenCalledWith(expect.stringContaining('TRUSTED_ORIGINS'))
      said.mockRestore()
      process.exitCode = undefined
    }
  })
})
