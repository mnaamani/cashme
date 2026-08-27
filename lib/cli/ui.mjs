// Terminal-side helpers: printing balances, asking a question, and validating what paparam
// hands us. Nothing here knows how the wallet works beyond the shape of what it reports.
import process from 'bare-process'
import { balances, totalBalances, DEFAULT_UNIT } from '../manager.mjs'

// A mint and unit at a time, then a total per unit. Amounts stringify to plain numbers, so
// they print as they come. Returns the snapshots holding reserved proofs, which is the one
// thing a caller has ever wanted from the listing.
export async function showBalances(wallet, label = 'Balance') {
  const reserved = []
  for (const [mintUrl, byUnit] of Object.entries(await balances(wallet))) {
    for (const balance of Object.values(byUnit)) {
      const held = Number(balance.reserved) ? ` (${balance.reserved} reserved)` : ''
      console.log(`${mintUrl}: ${balance.spendable} ${balance.unit}${held}`)
      if (Number(balance.reserved) > 0) reserved.push(balance)
    }
  }

  const totals = Object.values(await totalBalances(wallet))
  // An empty wallet has no units to total, and still has to say so.
  if (!totals.length) console.log(`${label}: 0 ${DEFAULT_UNIT}`)
  for (const total of totals) console.log(`${label}: ${total.spendable} ${total.unit}`)
  return reserved
}

// Spending is the one thing worth stopping to ask about, so `pay` confirms before it
// commits. Reads a line from stdin, which means `echo y | cashme pay ...` works as well as
// a terminal; with nothing to read, the answer is no.
export function confirm(question) {
  const stdin = process.stdin
  return new Promise((resolve) => {
    const answer = (value) => {
      stdin.off('data', ondata)
      stdin.off('end', onend)
      stdin.pause()
      resolve(value)
    }
    const ondata = (chunk) => {
      const line = chunk.toString().trim().toLowerCase()
      if (line === '') return
      answer(line === 'y' || line === 'yes')
    }
    const onend = () => answer(false)

    process.stdout.write(`${question} [y/N] `)
    stdin.on('data', ondata)
    stdin.on('end', onend)
    stdin.resume()
  })
}

// paparam hands flags over as strings; a bad one should stop the command, not reach a mint
// as NaN.
export function sats(value) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`--sats must be a positive whole number of sats, got "${value}"`)
  }
  return amount
}
