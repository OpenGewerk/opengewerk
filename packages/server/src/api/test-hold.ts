import { Client, type Pool, type PoolClient } from 'pg'
import { onTestFinished } from 'vitest'

/** A statement held in the test's own process before it reaches the database. */
export interface HeldQuery {
  /** Settles once the statement is held. */
  readonly reached: Promise<void>
  /** Sends it on to the database. */
  readonly release: () => void
}

/**
 * Holds the `nth` statement that `matches`, from any client of `pg` in this
 * process, until `release`: a request that has checked and is about to read
 * or write is stopped right there while the test changes what it checked.
 * Every other statement goes on as sent.
 *
 * Put back when the test finishes, whether it passed, failed or ran out of
 * time, and a statement still held is let go then: a test whose statement
 * is never reached waits for its time-out, and the files' other tests still
 * get the client as it was.
 */
export function holdQuery(
  matches: (text: string, values: readonly unknown[]) => boolean,
  nth = 1,
): HeldQuery {
  const query = Client.prototype.query
  let reached: () => void = () => undefined
  let release: () => void = () => undefined
  const atTheQuery = new Promise<void>((resolve) => {
    reached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let seen = 0

  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const config = args[0] as string | { text?: string; values?: unknown[] } | undefined
    const text = typeof config === 'string' ? config : (config?.text ?? '')
    const values = (typeof config === 'string' ? args[1] : (config?.values ?? args[1])) as
      unknown[] | undefined
    const forward = () => (query as (...given: unknown[]) => unknown).apply(this, args)

    if (seen < nth && matches(text, values ?? [])) {
      seen += 1

      if (seen === nth) {
        reached()

        return released.then(forward)
      }
    }

    return forward()
  } as typeof query

  onTestFinished(() => {
    Client.prototype.query = query
    release()
  })

  return { reached: atTheQuery, release }
}

/**
 * Waits until a statement waits for the transaction of `holder`
 * (opengewerk#911): a test that holds a lock in a transaction of its own lets
 * it go only once the request it holds up is really held up by it. Fails when
 * `work` is done first or nothing waits for the holder in time, so that a
 * test never goes on believing it raced when it did not.
 */
export async function waitingFor(
  pool: Pool,
  holder: PoolClient,
  work: Promise<unknown>,
): Promise<void> {
  const { rows } = await holder.query<{ pid: number }>('select pg_backend_pid() as pid')
  const pid = rows[0]?.pid
  let done = false

  work.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )

  for (let tries = 0; tries < 200; tries += 1) {
    const { rows: waiting } = await pool.query<{ waiting: number }>(
      'select count(*)::int as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [pid],
    )

    if ((waiting[0]?.waiting ?? 0) > 0) {
      return
    }

    if (done) {
      throw new Error('The work was done without ever waiting for the held transaction')
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error('Nothing waited for the held transaction')
}
