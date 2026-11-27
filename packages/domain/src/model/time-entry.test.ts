import { describe, expect, it } from 'vitest'

import { timeEntryYearProblem } from './time-entry.js'

describe('the year of a record of time (GHSA-9f85-85g8-g7w3)', () => {
  const now = new Date('2026-11-27T10:00:00Z')
  const refused = (year: number) =>
    `OpenGewerk nimmt Arbeitszeit für die Jahre 1970 bis 2027 an, nicht für ${String(year)}.`

  it('is one from 1970 to the year after this one', () => {
    expect(timeEntryYearProblem('1970-06-02T05:00:00Z', now)).toBeNull()
    expect(timeEntryYearProblem('2027-06-02T05:00:00Z', now)).toBeNull()
    expect(timeEntryYearProblem('1969-06-02T05:00:00Z', now)).toBe(refused(1969))
    expect(timeEntryYearProblem('2028-06-02T05:00:00Z', now)).toBe(refused(2028))
    // Two digits for the year, as a finger types them.
    expect(timeEntryYearProblem('0026-06-02T05:00:00Z', now)).toBe(refused(26))
  })

  it('is counted in Germany, as the database counts it', () => {
    // Half past midnight on New Year's Day 1970 in Germany, still 1969 in UTC.
    expect(timeEntryYearProblem('1969-12-31T23:30:00Z', now)).toBeNull()
    // And the last half hour of 2027 in UTC is 2028 in Germany.
    expect(timeEntryYearProblem('2027-12-31T23:30:00Z', now)).toBe(refused(2028))
  })

  it('takes a correction that stays in a year it may keep, even one outside', () => {
    expect(timeEntryYearProblem('0026-06-02T05:00:00Z', now, [26])).toBeNull()
    expect(timeEntryYearProblem('1501-06-02T05:00:00Z', now, [1500, 1501])).toBeNull()
    expect(timeEntryYearProblem('0026-06-02T05:00:00Z', now, [2026])).toBe(refused(26))
  })

  it('counts a year before the common era below 1, not as the year its era names', () => {
    // 2026 before the common era, in astronomical years -2025.
    expect(timeEntryYearProblem('-002025-06-02T05:00:00Z', now)).toBe(refused(-2025))
  })

  it('leaves a start that is no instant to the check of the times', () => {
    expect(timeEntryYearProblem('gestern', now)).toBeNull()
  })
})
