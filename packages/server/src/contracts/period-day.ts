import {
  type ContractRateDay,
  type DocumentId,
  type IsoDate,
  type MaintenanceContractId,
  supplyDayOf,
} from '@opengewerk/domain'
import { isUuid, type TenantTransaction } from '@opengewerk/platform-server'
import { and, eq, isNull } from 'drizzle-orm'

import { documents, maintenanceContracts } from '../database/schema/index.js'

type DocumentRow = typeof documents.$inferSelect

/**
 * The day of the maintenance of a draft recurring invoice whose period was
 * changed (#1037): the day its period pays for now, so that its rate, its
 * head and its e-invoice follow the period it bills, and the notice does not
 * take the change for one of the contract. Asked after the route and the sync
 * wrote a period, as the line of a surcharge is (#1087). Nothing for another
 * document, one without a contract or one that is no draft, and written only
 * where the day changes.
 */
export async function followPeriod(
  tx: TenantTransaction,
  documentId: string,
): Promise<DocumentRow | null> {
  if (!isUuid(documentId)) {
    return null
  }

  const [document] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId as DocumentId), isNull(documents.deletedAt)))

  if (
    !document ||
    document.kind !== 'recurring_invoice' ||
    document.status !== 'draft' ||
    document.maintenanceContractId === null
  ) {
    return null
  }

  const [contract] = await tx
    .select()
    .from(maintenanceContracts)
    .where(eq(maintenanceContracts.id, document.maintenanceContractId as MaintenanceContractId))

  if (!contract) {
    return null
  }

  const until = (document.serviceUntil ?? document.serviceFrom) as IsoDate | null
  const supplyOn =
    until === null
      ? null
      : supplyDayOf(
          {
            rateDay: contract.rateDay as ContractRateDay,
            firstVisitOn: contract.firstVisitOn as IsoDate,
            intervalMonths: contract.intervalMonths,
          },
          { until },
        )

  if (supplyOn === ((document.supplyOn as IsoDate | null) ?? null)) {
    return document
  }

  const [moved] = await tx
    .update(documents)
    .set({ supplyOn })
    .where(eq(documents.id, document.id))
    .returning()

  return moved ?? document
}
