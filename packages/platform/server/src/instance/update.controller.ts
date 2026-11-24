import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common'
import type { InstanceUpdateView } from '@opengewerk/platform-domain'

import { RequiresOperator } from '../api/authorization.js'
import { VERSION } from '../api/handed-in.js'
import { CurrentUser, type SignedInUser } from '../api/identity.js'
import { claimReconfirmation } from '../authentication/reconfirmation.js'
import { Database } from '../database/database.js'
import { listOperators } from './operators.js'
import {
  INSTANCE_UPDATES,
  type InstanceUpdates,
  readInstanceUpdate,
  requestInstanceUpdate,
  stillTelling,
  updateRefusedNow,
} from './update.js'

const updateUnconfirmed =
  'Die Instanz wird erst nach der Bestätigung mit Passwort und Code aktualisiert.'

/**
 * The update of the instance in its area (opengewerk#1093): which version
 * runs, the newest with its notes, the last update, and the request for one.
 *
 * Registered only where the application has the service for updates and
 * hands in its folders. Only for whoever runs the instance, and a request
 * only after confirming with password and code, like every change there that
 * reaches beyond one tenant: the update stops the instance for a minute and
 * changes what runs for every tenant on it.
 */
@Controller('instance/update')
export class InstanceUpdateController {
  constructor(
    private readonly database: Database,
    @Inject(INSTANCE_UPDATES) private readonly updates: InstanceUpdates,
    @Inject(VERSION) private readonly version: string | null,
  ) {}

  @Get()
  @RequiresOperator()
  state(): Promise<InstanceUpdateView> {
    return readInstanceUpdate(this.updates, this.version)
  }

  /**
   * Asks the service for an update to the version given, which has to be the
   * newest it found. The state is checked before the confirmation is spent,
   * so that nobody enters password and code for a request that would be
   * turned away; the service checks it again when it takes the request.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresOperator()
  async start(
    @CurrentUser() user: SignedInUser,
    @Body() body: unknown,
  ): Promise<InstanceUpdateView> {
    const wanted =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['version']
        : undefined

    if (typeof wanted !== 'string' || !/^\d+\.\d+\.\d+$/.test(wanted)) {
      throw new BadRequestException('Die Fassung fehlt, auf die aktualisiert werden soll.')
    }

    const view = await readInstanceUpdate(this.updates, this.version)
    const refused = updateRefusedNow(view, wanted) ?? (await stillTelling(this.updates, view))

    if (refused !== null) {
      throw new ConflictException(refused)
    }

    if (!(await claimReconfirmation(this.database, user.sessionId))) {
      throw new ForbiddenException(updateUnconfirmed)
    }

    const asking = (await listOperators(this.database, user.userId)).find(
      (operator) => operator.userId === user.userId,
    )

    await requestInstanceUpdate(this.updates, wanted, asking?.name || asking?.email || '')

    return readInstanceUpdate(this.updates, this.version)
  }
}
