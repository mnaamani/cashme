// The wallet's lifetime for one run, and the Ctrl-C handling the bluetooth commands need.
import process from 'bare-process'
import { openWallet } from '../manager.mjs'

// Every command opens the wallet through here, so it is always closed at the end of the
// run — and, since the store takes a lock, only one cashme holds it at a time.
let opened = null

export async function useWallet(dir) {
  opened = await openWallet(dir)
  // openWallet gives back proofs held by sends and payments that never went through (see
  // sweepPreparedOperations). That changes the balance about to be shown, so say so.
  for (const operation of opened.reclaimed) {
    console.error(
      `reclaimed ${operation.amount} ${operation.unit} reserved by a ${operation.kind} that never happened`
    )
  }
  return opened
}

export function closeWallet() {
  return opened?.close()
}

// A promise that settles when the user interrupts the run, and a way to stop listening.
//
// Both bluetooth commands wait without a timeout, so Ctrl-C is the normal way out. `give`
// has proofs reserved while it waits and hands them back; `get` just stops listening.
// `release()` restores the default, so a second Ctrl-C behaves as usual.
//
// Only SIGINT is one bare lets us finish — for the others it runs the handler and still
// takes the default action, so the cancel is a race. openWallet's sweep is the guarantee;
// this is only the tidy exit.
export function interrupted() {
  const signals = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']
  const listeners = []
  const promise = new Promise((resolve) => {
    for (const signal of signals) {
      // Resolve rather than reject: nothing may await this, and an unhandled rejection
      // would take the run down instead of the signal.
      const listener = () => resolve(new Error(`interrupted (${signal})`))
      process.on(signal, listener)
      listeners.push([signal, listener])
    }
  })
  const release = () => {
    for (const [signal, listener] of listeners) process.off(signal, listener)
  }
  return { promise, release }
}
