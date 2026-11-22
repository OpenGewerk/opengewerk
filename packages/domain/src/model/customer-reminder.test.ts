import type { IsoDate } from '@opengewerk/platform-domain'
import { describe, expect, it } from 'vitest'

import {
  reminderGroundProblem,
  reminderGroundText,
  reminderSentence,
  reminderWay,
} from './customer-reminder.js'

const day = (value: string) => value as IsoDate

describe('the way a customer is reminded', () => {
  it('belongs to the contract, by mail or else by a call', () => {
    expect(reminderWay(null, true, true, true)).toBe('mail')
    expect(reminderWay(null, true, false, true)).toBe('call')
    expect(reminderWay('existing_customer', true, false, true)).toBe('call')
  })

  it('needs a consent or a customer of the business without a contract, and goes nowhere with neither', () => {
    expect(reminderWay(null, false, true, true)).toBeNull()
    expect(reminderWay(null, false, false, true)).toBeNull()
    expect(reminderWay('consent', false, true, true)).toBe('mail')
    expect(reminderWay('consent', false, false, true)).toBe('call')
    expect(reminderWay('existing_customer', false, true, true)).toBe('mail')
  })

  /**
   * § 7 Abs. 3 Nr. 4 UWG wants the notice on the objection given when the
   * address was collected, and without the office's confirmation of it the
   * mail is advertising nobody agreed to (#1026). A contract does not ask.
   */
  it('mails a customer of the business only once the notice at the collection is confirmed', () => {
    expect(reminderWay('existing_customer', false, true, false)).toBeNull()
    expect(reminderWay('existing_customer', false, true, true)).toBe('mail')
    expect(reminderWay('existing_customer', true, true, false)).toBe('mail')
  })

  it('calls a customer of the business only with a consent, since § 7 Abs. 3 UWG covers mail alone', () => {
    expect(reminderWay('existing_customer', false, false, true)).toBeNull()
  })

  it('stops for a customer who stopped them, a contract and all', () => {
    expect(reminderWay('objected', true, true, true)).toBeNull()
    expect(reminderWay('objected', true, false, true)).toBeNull()
    expect(reminderWay('objected', false, true, true)).toBeNull()
  })
})

describe('the sentence below a reminder', () => {
  it('names the contract it belongs to, before any ground', () => {
    expect(reminderSentence('existing_customer', 'WV-2026-0003')).toBe(
      'Diese Erinnerung gehört zu Ihrem Wartungsvertrag WV-2026-0003. Möchten Sie keine Erinnerungen mehr, genügt eine kurze Antwort auf diese E-Mail.',
    )
  })

  it('names the right to object of § 7 Abs. 3 Nr. 4 UWG for a customer of the business', () => {
    expect(reminderSentence('existing_customer', null)).toContain('jederzeit widersprechen')
    expect(reminderSentence('existing_customer', null)).toContain(
      'Übermittlungskosten nach den Basistarifen',
    )
  })

  it('names the withdrawal of a consent', () => {
    expect(reminderSentence('consent', null)).toContain('Einwilligung jederzeit widerrufen')
  })
})

describe('the ground of a customer', () => {
  it('reads as a fact of the record', () => {
    expect(reminderGroundText(null, null, true)).toBe('Nur zu einem Wartungsvertrag')
    expect(reminderGroundText('consent', day('2024-03-12'), true)).toBe(
      'Einwilligung vom 12.03.2024',
    )
    expect(reminderGroundText('existing_customer', day('2024-03-12'), true)).toBe(
      'Bestandskunde nach § 7 Abs. 3 UWG, seit 12.03.2024',
    )
    expect(reminderGroundText('objected', day('2026-11-02'), true)).toBe('Abbestellt am 02.11.2026')
  })

  it('is one of the list with its day, or none without one', () => {
    expect(reminderGroundProblem(null, null, false)).toBeNull()
    expect(reminderGroundProblem('consent', '2024-03-12', false)).toBeNull()
    expect(reminderGroundProblem('objected', '2026-11-02', false)).toBeNull()
    expect(reminderGroundProblem('newsletter', '2024-03-12', false)).not.toBeNull()
    expect(reminderGroundProblem('consent', null, false)).not.toBeNull()
    expect(reminderGroundProblem('consent', '12.03.2024', false)).not.toBeNull()
    expect(reminderGroundProblem(null, '2024-03-12', false)).not.toBeNull()
  })

  it('has the confirmation of the notice only with a customer of the business', () => {
    expect(reminderGroundProblem('existing_customer', '2024-03-12', true)).toBeNull()
    // Stored, and counted as none until somebody confirms it.
    expect(reminderGroundProblem('existing_customer', '2024-03-12', false)).toBeNull()
    expect(reminderGroundProblem('existing_customer', '2024-03-12', undefined)).toBeNull()
    expect(reminderGroundProblem('consent', '2024-03-12', true)).not.toBeNull()
    expect(reminderGroundProblem(null, null, true)).not.toBeNull()
    expect(reminderGroundProblem('existing_customer', '2024-03-12', 'yes')).not.toBeNull()
  })

  it('says of a customer of the business that nobody confirmed the notice', () => {
    expect(reminderGroundText('existing_customer', day('2024-03-12'), false)).toBe(
      'Bestandskunde nach § 7 Abs. 3 UWG, seit 12.03.2024, Hinweis bei der Erhebung nicht bestätigt',
    )
  })
})
