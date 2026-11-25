import { circuitFigureFields, circuitProblems, distributionBoardKinds } from './electrical.js'
import { inverterProblems, pvModuleProblems, pvStringProblems } from './photovoltaic.js'
import type { RecordState } from '../sync/rules.js'

// What a change to the electrical and the PV structure (ADR 0014) may not
// bring, judged as the part would stand afterwards. The server asks it before
// it writes an operation, and a device before it queues one that no form
// checked: a version kept in a conflict (opengewerk#1072).

/** The value a field has once the operation is through: what it sets, or what the row holds. */
export function valueAfter(
  field: string,
  values: Readonly<Record<string, unknown>>,
  current: RecordState | null,
): unknown {
  return field in values ? values[field] : (current?.[field] ?? null)
}

/**
 * What an operation on a circuit takes along without saying it (#1021): a
 * type of RCD taken away takes the selective with it, as the form does. A
 * device that leaves the selective alone, because somebody set it meanwhile
 * or because its version does not know it, would otherwise be refused for a
 * field it never touched, with its whole transmission.
 *
 * An application applies it twice, to the values its check judges and to
 * those it writes (`complete`), so that the check judges what is written.
 */
export function circuitAlong(
  entity: string,
  values: Readonly<Record<string, unknown>>,
  current: RecordState | null,
): Readonly<Record<string, unknown>> {
  if (
    entity !== 'circuits' ||
    !('rcdType' in values) ||
    values['rcdType'] !== null ||
    'rcdSelective' in values ||
    current?.['rcdSelective'] !== true
  ) {
    return values
  }

  return { ...values, rcdSelective: false }
}

/**
 * The figures of the PV structure (#300), each a range of its own: the ones an
 * operation sets are the ones to judge, and one it leaves alone stands as the
 * database holds it.
 */
const pvFigures: Readonly<
  Record<string, (record: Readonly<Record<string, unknown>>) => Readonly<Record<string, string>>>
> = {
  inverters: inverterProblems,
  pv_strings: pvStringProblems,
  pv_modules: pvModuleProblems,
}

/**
 * What a device may not send at all, as the sentence its form shows for it,
 * or null when nothing is wrong.
 *
 * A mistake in the client and not a disagreement between two people, like a
 * payment term out of range: the forms ask the same function before anything
 * is queued. The one disagreement among these is a selective RCD sent while
 * somebody took its type away, which `selectiveRefusal` answers first. Asked here, the answer names the field; left to the database,
 * the check or the enum would refuse the whole transmission with a sentence
 * nobody on site could act on.
 *
 * The circuit is judged as it would stand afterwards, since whether a curve
 * goes with a device depends on both and a patch may carry only one. Only
 * when the operation sets one of its figures: a circuit that is only renamed
 * is not held to a figure nobody touched.
 */
export function structureProblem(
  entity: string,
  values: Readonly<Record<string, unknown>>,
  current: RecordState | null,
): string | null {
  if (entity === 'distribution_boards' && 'kind' in values) {
    return (distributionBoardKinds as readonly unknown[]).includes(values['kind'])
      ? null
      : 'Diese Art von Verteiler ist unbekannt.'
  }

  // Its own entries only: `__proto__` is no part of the PV structure.
  const pv = Object.hasOwn(pvFigures, entity) ? pvFigures[entity] : undefined

  if (pv) {
    return Object.values(pv(values))[0] ?? null
  }

  if (entity !== 'circuits' || !circuitFigureFields.some((field) => field in values)) {
    return null
  }

  // A field neither sent nor stored stays out: a new circuit sent without its
  // nominal voltage is up to 500 V by the default of the column, and is not
  // one whose voltage was set to nothing (#1021).
  const standing = Object.fromEntries(
    circuitFigureFields.flatMap((field) =>
      field in values || (current !== null && field in current)
        ? [[field, valueAfter(field, values, current)]]
        : [],
    ),
  )

  return Object.values(circuitProblems(standing))[0] ?? null
}
