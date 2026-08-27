// The wallet's lifetime for one run of the CLI, and the Ctrl-C handling the long-running
// commands need.
import process from 'bare-process'
import { openWallet } from '../manager.mjs'

// Every command opens the wallet through here, so only one cashme can hold it at a time
// (see lib/coco-store.mjs) and it is always closed at the end of the run.
let opened = null

export async function useWallet(dir) {
  opened = await openWallet(dir)
  // openWallet gives back the proofs held by sends and payments that were prepared and
  // never went through (see sweepPreparedOperations). That changes the balance the user is
  // about to see, so say so.
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
// Both bluetooth commands wait without a timeout, so Ctrl-C is the normal way out of them
// rather than an accident. `give` reserves proofs before it goes looking for a neighbour,
// and until the token exists that reservation can still be handed back — so the window is
// worth catching; after it, there is nothing to cancel. `get` has nothing to undo and
// simply stops listening. Either way `release()` puts the default behaviour back, so a
// second Ctrl-C does what Ctrl-C usually does.
//
// SIGINT is the one bare lets us finish: for the others it runs the handler but still
// takes the default action, so the cancel is a race the run can lose. That is what the
// sweep in openWallet is for — this is the tidy exit, not the guarantee.
export function interrupted() {
  const signals = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']
  const listeners = []
  const promise = new Promise((resolve) => {
    for (const signal of signals) {
      // Resolve rather than reject: nothing may ever await this, and an unhandled
      // rejection would take the run down instead of the signal.
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
