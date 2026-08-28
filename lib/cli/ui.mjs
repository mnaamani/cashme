// Terminal-side helpers: printing balances, asking a question, validating flags. Nothing
// here knows how the wallet works beyond the shape of what it reports.
import process from 'bare-process'
import { renderUnicodeCompact } from 'uqr'
import { balances, totalBalances, DEFAULT_UNIT } from '../manager.mjs'

// A mint and unit at a time, then a total per unit. Amounts stringify to plain numbers, so
// they print as they come. Returns the snapshots holding reserved proofs.
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

// Scanners want the quiet zone the spec asks for — uqr defaults to 1 module — and error
// correction M rather than L, whose redundancy is what absorbs the row-to-row gaps a
// terminal with loose line spacing leaves through the code. Together they cost 10 columns:
// a 240-character invoice goes 51 wide to 61, still inside an 80-column terminal.
const QR_OPTIONS = { border: 4, ecc: 'M' }

// uqr draws a *light* module as █ and a dark one as a space, so it reads correctly only
// where the foreground is light and the background dark. On a light terminal profile the
// whole code comes out inverted, which some scanners take and others refuse — so set both
// colours per line and stop depending on the theme. Re-applied per line, since a terminal
// resets SGR state at the line end.
const QR_LIGHT_ON_DARK = '\x1b[97;40m'
const QR_RESET = '\x1b[0m'

// A QR is always an odd number of modules across, and a border keeps it odd, so the last
// of the half-height rows always has a module row and nothing under it — which uqr fills
// in dark (getDataAt defaults out-of-range to true). That lays a dark bar along the bottom
// edge and takes half a module off the quiet zone there. Repaint that row's lower half
// light: ▀ (light over dark) becomes █, and a space (dark over dark) becomes ▄.
function lightenLastRow(lines) {
  const last = lines.length - 1
  if (last < 0) return lines
  lines[last] = lines[last].replace(/[\u2580 ]/g, (ch) => (ch === '\u2580' ? '\u2588' : '\u2584'))
  return lines
}

// The invoice itself goes to stdout so `cashme deposit ... | ...` still yields just the
// bolt11 string; the QR is decoration and goes to stderr alongside the progress lines.
//
// bolt11 is bech32 and so case-insensitive, and an all-uppercase payload encodes in the QR
// alphanumeric mode rather than byte mode — about half the bits, which is the difference
// between a code that fits a terminal and one that does not. Wallets read the uppercase
// form; we still print the invoice as the mint gave it to us.
export function showInvoice(request) {
  console.log('pay lightning invoice:', request)
  // Two rows of modules per line of text, so the code stays roughly square. Written
  // straight to stderr, not console.error: the deposit poll writes its dots the same way,
  // and the two paths do not interleave in order.
  const qr = renderUnicodeCompact(request.toUpperCase(), QR_OPTIONS)
  for (const line of lightenLastRow(qr.split('\n'))) {
    process.stderr.write(`${QR_LIGHT_ON_DARK}${line}${QR_RESET}\n`)
  }
}

// Used by `withdraw` before it commits. Reads a line from stdin, so `echo y | cashme withdraw ...`
// works as well as a terminal; with nothing to read, the answer is no.
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

// paparam hands flags over as strings; a bad one must stop the command, not reach a mint
// as NaN.
export function sats(value) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`--sats must be a positive whole number of sats, got "${value}"`)
  }
  return amount
}
