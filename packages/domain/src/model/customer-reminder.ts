import type { IsoDate } from '@opengewerk/platform-domain'

/**
 * Reminders of a due inspection or maintenance to the customer (#316,
 * Feature-Gliederung 3.7, decided on 27.09.2026).
 *
 * With a maintenance contract the reminder belongs to the contract. Without
 * one it is advertising, which by mail needs a consent given beforehand
 * (§ 7 Abs. 2 Nr. 2 UWG) or the ground of § 7 Abs. 3 UWG: the business got
 * the address when it sold a good or service, reminds of its own similar
 * services, told the customer at the time that they may object, and says so
 * again in every mail. That ground covers mail and nothing else; a call to a
 * consumer needs a consent of its own (§ 7 Abs. 2 Nr. 1 UWG), so a customer
 * of that ground without an address is not called.
 *
 * Which ground a customer has is what the office stored at the customer;
 * none means only the reminders of a contract. A customer who stopped them
 * gets none at all, a contract's included.
 */
export const reminderGrounds = ['consent', 'existing_customer', 'objected'] as const

export type ReminderGround = (typeof reminderGrounds)[number]

/** The choice of the form, with none first: only what a contract brings. */
export const reminderGroundLabel: Readonly<Record<ReminderGround | 'none', string>> = {
  none: 'Nur zu einem Wartungsvertrag',
  consent: 'Einwilligung',
  existing_customer: 'Bestandskunde nach § 7 Abs. 3 UWG',
  objected: 'Abbestellt',
}

/** What each choice means, as the form explains it; the board of the canvas, version 135, uses the same words. */
export const reminderGroundExplanation: Readonly<Record<ReminderGround | 'none', string>> = {
  none: 'Erinnert wird nur an Wartungen und Prüfungen, die zu einem laufenden Wartungsvertrag gehören.',
  consent:
    'Der Kunde hat ausdrücklich eingewilligt, an fällige Prüfungen und Wartungen erinnert zu werden, per E-Mail oder Telefon. Die Einwilligung bewahrt der Betrieb auf.',
  existing_customer:
    'Nur per E-Mail, und nur, wenn der Betrieb die Adresse beim Verkauf einer Ware oder Dienstleistung bekommen und den Kunden dabei auf sein Widerspruchsrecht hingewiesen hat. Jede Erinnerung nennt es. Angerufen wird nur mit einer Einwilligung.',
  objected: 'Der Kunde bekommt keine Erinnerungen mehr, auch nicht zu einem Wartungsvertrag.',
}

function germanDay(day: IsoDate): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`
}

/**
 * The ground of a customer as a fact of the record: "Einwilligung vom
 * 12.03.2024". A customer of section 7 (3) UWG whose notice on the objection
 * nobody confirmed says so (#1026): stored as one, reminded as none.
 */
export function reminderGroundText(
  ground: ReminderGround | null,
  since: IsoDate | null,
  objectionNoticeConfirmed: boolean,
): string {
  if (ground === null) {
    return reminderGroundLabel.none
  }

  const label = reminderGroundLabel[ground]

  if (since === null) {
    return label
  }

  switch (ground) {
    case 'consent':
      return `${label} vom ${germanDay(since)}`
    case 'existing_customer':
      return objectionNoticeConfirmed
        ? `${label}, seit ${germanDay(since)}`
        : `${label}, seit ${germanDay(since)}, Hinweis bei der Erhebung nicht bestätigt`
    case 'objected':
      return `${label} am ${germanDay(since)}`
  }
}

/**
 * How a customer is reminded of something due, or null when not at all: by
 * mail where there is an address, by a call where a call is allowed.
 *
 * A customer of section 7 (3) UWG only with the notice on the objection
 * confirmed: number 4 wants it given when the address was collected, and
 * without it the mail is advertising nobody agreed to (#1026).
 */
export type ReminderWay = 'mail' | 'call'

/**
 * Whether the notice on the objection is confirmed for the address the
 * customer has (#1026): the confirmation names the address it was given for,
 * and a new address, written by any client on any device, needs it again.
 * Compared without case and surrounding space, as an address is.
 */
export function objectionNoticeConfirmedFor(email: unknown, confirmedFor: unknown): boolean {
  return sameEmailAddress(email, confirmedFor)
}

/**
 * Whether two texts are the same e-mail address: compared without case and
 * surrounding space, and never when one is empty. Whatever a request carries
 * that is no text is no address (the review). The confirmation of the notice
 * and the check before a reminder goes out compare the same way.
 */
export function sameEmailAddress(left: unknown, right: unknown): boolean {
  const one = typeof left === 'string' ? left.trim().toLowerCase() : ''
  const other = typeof right === 'string' ? right.trim().toLowerCase() : ''

  return one !== '' && one === other
}

export function reminderWay(
  ground: ReminderGround | null,
  underContract: boolean,
  hasAddress: boolean,
  objectionNoticeConfirmed: boolean,
): ReminderWay | null {
  if (ground === 'objected') {
    return null
  }

  if (underContract || ground === 'consent') {
    return hasAddress ? 'mail' : 'call'
  }

  if (ground === 'existing_customer') {
    return hasAddress && objectionNoticeConfirmed ? 'mail' : null
  }

  return null
}

/**
 * The sentence below the business's text, by what the reminder rests on:
 * the contract it belongs to, the consent that may be withdrawn, or the
 * objection § 7 Abs. 3 Nr. 4 UWG wants named in every mail. The text is the
 * business's, this sentence the law's, like the one about the instructions
 * under a confirmation (#315).
 */
export function reminderSentence(ground: ReminderGround | null, contract: string | null): string {
  if (contract !== null) {
    return `Diese Erinnerung gehört zu Ihrem Wartungsvertrag ${contract}. Möchten Sie keine Erinnerungen mehr, genügt eine kurze Antwort auf diese E-Mail.`
  }

  return ground === 'consent'
    ? 'Sie bekommen diese Erinnerung, weil Sie darin eingewilligt haben. Sie können die Einwilligung jederzeit widerrufen; eine kurze Antwort auf diese E-Mail genügt.'
    : 'Sie bekommen diese Erinnerung als unser Kunde. Sie können der Verwendung Ihrer E-Mail-Adresse für solche Erinnerungen jederzeit widersprechen, ohne dass Ihnen dafür andere als die Übermittlungskosten nach den Basistarifen entstehen; eine kurze Antwort auf diese E-Mail genügt.'
}

/**
 * Whether a reminder written before still may go, asked as it leaves (#1026,
 * CodeRabbit): never to a customer who objected since, and one that rests on
 * the consent or on section 7 (3) UWG only while that ground holds, the
 * latter with the notice confirmed. The ground a reminder rests on is the one
 * its text names (`reminderSentence`); one of a contract rests on the
 * contract, which only an objection ends.
 */
export function reminderStillHolds(
  text: string,
  ground: ReminderGround | null,
  objectionNoticeConfirmed: boolean,
): boolean {
  if (ground === 'objected') {
    return false
  }

  if (text.includes(reminderSentence('consent', null))) {
    return ground === 'consent'
  }

  if (text.includes(reminderSentence('existing_customer', null))) {
    return ground === 'existing_customer' && objectionNoticeConfirmed
  }

  return true
}

/**
 * The number of the contract a reminder rests on, as its text names it
 * (`reminderSentence`), or null for one that rests on no contract (#1026,
 * CodeRabbit).
 */
export function reminderContract(text: string): string | null {
  const marker = '<contract>'
  const [before = '', after = ''] = reminderSentence(null, marker).split(marker)
  const start = text.indexOf(before)

  if (start === -1) {
    return null
  }

  const from = start + before.length
  const end = text.indexOf(after, from)

  return end === -1 ? null : text.slice(from, end)
}

/**
 * What is wrong with a ground and its day as a customer is to have them, or
 * null: a ground is one of the list or none, and a ground has the day it was
 * given, which none has not.
 *
 * The confirmation of the notice on the objection (#1026) is the address it
 * was given for, none, or not part of the write, and an address only for a
 * customer of section 7 (3) UWG. Such a customer without it may be stored, as
 * every one from before the question is, and counts as none (`reminderWay`);
 * the record says so.
 */
export function reminderGroundProblem(
  ground: unknown,
  since: unknown,
  objectionNoticeAddress: unknown,
): string | null {
  if (
    objectionNoticeAddress !== undefined &&
    objectionNoticeAddress !== null &&
    (typeof objectionNoticeAddress !== 'string' || objectionNoticeAddress.trim() === '')
  ) {
    return 'Die Bestätigung des Hinweises auf den Widerspruch nennt die E-Mail-Adresse, für die er gegeben wurde.'
  }

  const objectionNoticeConfirmed = typeof objectionNoticeAddress === 'string'

  const elsewhere =
    'Die Bestätigung des Hinweises auf den Widerspruch gehört nur zum Bestandskunden nach § 7 Abs. 3 UWG.'

  if (ground === null || ground === undefined) {
    if (since !== null && since !== undefined) {
      return 'Ohne Grundlage für Erinnerungen gibt es keinen Tag dazu.'
    }

    return objectionNoticeConfirmed === true ? elsewhere : null
  }

  if (typeof ground !== 'string' || !(reminderGrounds as readonly string[]).includes(ground)) {
    return 'Diese Grundlage für Erinnerungen gibt es nicht.'
  }

  if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return 'Zur Grundlage für Erinnerungen gehört der Tag, seit dem sie gilt.'
  }

  return ground !== 'existing_customer' && objectionNoticeConfirmed === true ? elsewhere : null
}
