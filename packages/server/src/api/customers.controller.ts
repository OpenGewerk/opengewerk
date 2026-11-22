import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common'
import {
  type CustomerId,
  objectionNoticeConfirmedFor,
  reminderGroundProblem,
} from '@opengewerk/domain'
import { Database, pick, requireFields, requireSomething } from '@opengewerk/platform-server'
import { and, eq, isNull } from 'drizzle-orm'

import { customers, customerTags } from '../database/schema/index.js'
import { RequiresPermission } from './authorization.js'
import { setTags, tagChoiceFrom } from './tag-choice.js'
import { CurrentIdentity, type RequestIdentity } from './identity.js'
import { notRestricted } from '../privacy/customer-erasure.js'

const writableFields = [
  'kind',
  'name',
  'email',
  'phone',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'country',
  'vatId',
  'buyerReference',
  'isBusiness',
  'isConstructionServiceRecipient',
  'taxExemptionCertificateNumber',
  'taxExemptionValidUntil',
  'reminderGround',
  'reminderGroundOn',
  'objectionNoticeAddress',
  'notes',
] as const

/** What a customer holds of its ground for reminders before a write. */
interface StoredGround {
  readonly ground: string | null
  readonly since: string | null
  readonly email: string | null
  readonly confirmedFor: string | null
}

/** A customer that does not exist yet holds no ground. */
const noGround: StoredGround = { ground: null, since: null, email: null, confirmedFor: null }

/** Whether a write touches the ground for reminders, its day or the confirmation. */
function touchesReminderGround(values: Record<string, unknown>): boolean {
  return (
    'reminderGround' in values || 'reminderGroundOn' in values || 'objectionNoticeAddress' in values
  )
}

/**
 * A ground for reminders comes with its day (#316), and the confirmation of
 * the notice on the objection only with a customer of § 7 Abs. 3 UWG
 * (#1026). Checked against what the customer holds after the write, the
 * stored values with the written ones over them: the office sends only the
 * fields it changed (`writeDirectly`), so a write that only ticks the
 * confirmation or only moves the day comes without the ground (#1026, the
 * review). Another ground takes a confirmation stored before away; the same
 * ground without it in the write leaves it, as a form of the version before
 * sends it.
 */
function requireReminderGround(
  values: Record<string, unknown>,
  stored: StoredGround = noGround,
): void {
  // A new address takes a confirmation for another one away (#1026,
  // CodeRabbit): it confirms nothing for the new one, and going back to the
  // old address later must not make it hold again without the box. A
  // confirmation that did not hold for the stored address either, as a
  // device can create a customer with one, goes as well.
  if (
    'email' in values &&
    !('objectionNoticeAddress' in values) &&
    stored.confirmedFor !== null &&
    (!objectionNoticeConfirmedFor(stored.email, stored.confirmedFor) ||
      !objectionNoticeConfirmedFor(values['email'], stored.confirmedFor))
  ) {
    values['objectionNoticeAddress'] = null
  }

  if (!touchesReminderGround(values)) {
    return
  }

  const ground = 'reminderGround' in values ? values['reminderGround'] : stored.ground
  const since = 'reminderGroundOn' in values ? values['reminderGroundOn'] : stored.since

  if ('reminderGround' in values && ground !== 'existing_customer') {
    values['objectionNoticeAddress'] ??= null
  }

  const confirmedFor =
    'objectionNoticeAddress' in values ? values['objectionNoticeAddress'] : stored.confirmedFor
  const problem = reminderGroundProblem(ground, since, confirmedFor)

  if (problem !== null) {
    throw new UnprocessableEntityException(problem)
  }

  // A confirmation written is for the address the customer has after the
  // write; one for another address would confirm nothing (#1026).
  const email = 'email' in values ? values['email'] : stored.email

  if (
    'objectionNoticeAddress' in values &&
    values['objectionNoticeAddress'] !== null &&
    !objectionNoticeConfirmedFor(email, values['objectionNoticeAddress'])
  ) {
    throw new UnprocessableEntityException(
      'Der Hinweis auf den Widerspruch wird für die E-Mail-Adresse des Kunden bestätigt.',
    )
  }
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly database: Database) {}

  @Get()
  @RequiresPermission('customer.read')
  list(@CurrentIdentity() identity: RequestIdentity) {
    // Without the customers restricted on a request for deletion (#845).
    return this.database.forTenant(identity, (tx) =>
      tx
        .select()
        .from(customers)
        .where(and(isNull(customers.deletedAt), notRestricted(customers.id))),
    )
  }

  @Post()
  @RequiresPermission('customer.create')
  async create(@CurrentIdentity() identity: RequestIdentity, @Body() body: unknown) {
    const values = pick(body, writableFields)
    requireFields(values, ['kind', 'name'])
    requireReminderGround(values)

    const [created] = await this.database.forTenant(identity, (tx) =>
      tx
        .insert(customers)
        // The values came through `pick`, so no column can be set that this
        // route does not offer. What is left is whether the values fit their
        // columns, and that is the database's job: enums, not null, formats.
        .values({ ...(values as typeof customers.$inferInsert), tenantId: identity.tenantId })
        .returning(),
    )

    return created
  }

  @Patch(':id')
  @RequiresPermission('customer.write')
  async update(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const values = pick(body, writableFields)
    requireSomething(values)

    const [updated] = await this.database.forTenant(identity, async (tx) => {
      // The stored ground, held until the write, so that the check and the
      // write see the same one; also for a new address, which takes a
      // confirmation for another one away.
      if (touchesReminderGround(values) || 'email' in values) {
        const [stored] = await tx
          .select({
            ground: customers.reminderGround,
            since: customers.reminderGroundOn,
            email: customers.email,
            confirmedFor: customers.objectionNoticeAddress,
          })
          .from(customers)
          .where(and(eq(customers.id, id as CustomerId), isNull(customers.deletedAt)))
          .for('update')

        if (stored) {
          requireReminderGround(values, stored)
        }
      }

      return tx
        .update(customers)
        .set(values as Partial<typeof customers.$inferInsert>)
        .where(and(eq(customers.id, id as CustomerId), isNull(customers.deletedAt)))
        .returning()
    })

    if (!updated) {
      // Either it does not exist or it belongs to somebody else. The answer is
      // the same on purpose: anything else would tell a caller which ids exist
      // in other tenants.
      throw new NotFoundException()
    }

    return updated
  }

  /**
   * The tags of the customer as the whole list (#314), `{ tagIds, newTags }`:
   * the tags it is to have and names for new ones, which become tags of the
   * business unless one by that name is there already.
   */
  @Put(':id/tags')
  @RequiresPermission('customer.write')
  async tag(
    @CurrentIdentity() identity: RequestIdentity,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const choice = tagChoiceFrom(body)

    return this.database.forTenant(identity, async (tx) => {
      const [record] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, id as CustomerId), isNull(customers.deletedAt)))
        .for('no key update')

      if (!record) {
        throw new NotFoundException()
      }

      return setTags(tx, identity.tenantId, { kind: 'customer', id: record.id }, choice)
    })
  }

  /**
   * Marked as deleted, not removed. A row that is gone is a row a device that
   * was offline never hears about, because a delta pull delivers what changed
   * and a row that is no longer there is not among it.
   */
  @Delete(':id')
  @RequiresPermission('customer.write')
  async remove(@CurrentIdentity() identity: RequestIdentity, @Param('id') id: string) {
    const [removed] = await this.database.forTenant(identity, async (tx) => {
      const now = new Date()
      const [gone] = await tx
        .update(customers)
        .set({ deletedAt: now })
        .where(and(eq(customers.id, id as CustomerId), isNull(customers.deletedAt)))
        .returning()

      // Its tags go with it, as a deleted tag takes its assignments (#314).
      if (gone) {
        await tx
          .update(customerTags)
          .set({ deletedAt: now })
          .where(and(eq(customerTags.customerId, gone.id), isNull(customerTags.deletedAt)))
      }

      return [gone]
    })

    if (!removed) {
      throw new NotFoundException()
    }

    return removed
  }
}
