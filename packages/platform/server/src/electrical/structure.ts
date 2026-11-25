import {
  type ConflictReason,
  type Operation,
  type RecordState,
  valueAfter,
} from '@opengewerk/platform-domain'
import { and, eq, isNull } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { TenantTransaction } from '../database/database.js'
import { isUuid } from '../database/identifier.js'

// What the sync of an application asks about the electrical and the PV
// structure before it writes a part (ADR 0014): the figures, and whether a
// circuit names a section of its own board.

/** The sections of an application (`electricalSchema`), as far as a check reads them. */
type Sections = PgTable & {
  readonly id: PgColumn
  readonly distributionBoardId: PgColumn
  readonly deletedAt: PgColumn
}

// Judged on the device as well, before it queues a change (opengewerk#1072),
// and therefore in the domain; the names stay here for whoever imports them
// from the server.
export { circuitAlong, structureProblem, valueAfter } from '@opengewerk/platform-domain'

/** Why a part of the structure may not land where it says, in the shape of a sync conflict. */
export interface StructureRefusal {
  readonly reason: ConflictReason
  readonly fields: readonly string[]
}

/**
 * A selective RCD sent for a circuit whose type somebody took away since the
 * device last saw it (#1021): two people disagree, and the device made no
 * mistake, so it is a conflict about this one circuit and not a refusal of
 * the whole transmission. Without a version to compare, or with the version
 * the device saw, a selective without a type stays the mistake
 * `structureProblem` names.
 */
export function selectiveRefusal(
  entity: string,
  values: Readonly<Record<string, unknown>>,
  current: RecordState | null,
  baseVersion: number | null,
): StructureRefusal | null {
  if (
    entity !== 'circuits' ||
    values['rcdSelective'] !== true ||
    'rcdType' in values ||
    current === null ||
    (current['rcdType'] ?? null) !== null ||
    baseVersion === null ||
    baseVersion === current['version']
  ) {
    return null
  }

  return { reason: 'changed_elsewhere', fields: ['rcdType', 'rcdSelective'] }
}

/**
 * Whether the section a circuit names belongs to the board it hangs on.
 *
 * Whether the board and the section are there at all, in this tenant and not
 * marked as deleted, is the question every reference of every entity gets. This is the one the structure adds: a section of the
 * right business can still be a section of another board. The key over
 * section and board refuses that too, but inside the transaction, where it
 * would take every other operation of the transmission along; refused here,
 * it is a conflict about this one circuit. The sections are the table of the
 * application, made with `electricalSchema`.
 *
 * Asked when a circuit is created, and whenever an operation moves it to
 * another section or another board, since the pair is what has to fit.
 */
export async function sectionRefusal(
  sections: Sections,
  tx: TenantTransaction,
  operation: Operation,
  values: Readonly<Record<string, unknown>>,
  current: RecordState | null,
): Promise<StructureRefusal | null> {
  if (
    operation.entity !== 'circuits' ||
    operation.kind === 'delete' ||
    (operation.kind !== 'create' &&
      !('boardSectionId' in values) &&
      !('distributionBoardId' in values))
  ) {
    return null
  }

  const section = valueAfter('boardSectionId', values, current)

  if (section === null) {
    return null
  }

  const [found] = isUuid(section)
    ? await tx
        .select({ board: sections.distributionBoardId })
        .from(sections)
        .where(and(eq(sections.id, section as never), isNull(sections.deletedAt)))
    : []

  return found && found.board === valueAfter('distributionBoardId', values, current)
    ? null
    : { reason: 'record_missing', fields: ['boardSectionId'] }
}
