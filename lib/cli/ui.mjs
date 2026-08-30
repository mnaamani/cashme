// Terminal-side helpers: printing balances, asking a question, validating flags. Nothing
// here knows how the wallet works beyond the shape of what it reports.
//
// What a command says about itself goes to stderr through note() (see lib/notes.mjs), and
// stdout is left for the one thing it produces — the invoice `deposit` prints, the token
// `give` prints — so a run can be piped somewhere and yield only its payload.
import process from 'bare-process'
import { renderUnicodeCompact, encode } from 'uqr'
import { note, write } from '../notes.mjs'
import { balances, totalBalances, normalizeUnit, DEFAULT_UNIT } from '../manager.mjs'

// A mint and unit at a time, then a total per unit. Amounts stringify to plain numbers, so
// they print as they come. Returns the snapshots holding reserved proofs.
//
// `stderr` for the commands whose stdout carries a payload; `balance` itself is the one
// command where the balance *is* the payload.
export async function showBalances(wallet, label = 'Balance', { stderr = false } = {}) {
  const line = stderr ? note : console.log
  const reserved = []
  for (const [mintUrl, byUnit] of Object.entries(await balances(wallet))) {
    for (const balance of Object.values(byUnit)) {
      const held = Number(balance.reserved) ? ` (${balance.reserved} reserved)` : ''
      line(`${mintUrl}: ${balance.spendable} ${balance.unit}${held}`)
      if (Number(balance.reserved) > 0) reserved.push(balance)
    }
  }

  const totals = Object.values(await totalBalances(wallet))
  // An empty wallet has no units to total, and still has to say so.
  if (!totals.length) line(`${label}: 0 ${DEFAULT_UNIT}`)
  for (const total of totals) line(`${label}: ${total.spendable} ${total.unit}`)
  return reserved
}

// Scanners want the quiet zone the spec asks for — uqr defaults to 1 module — and error
// correction M rather than L, whose redundancy is what absorbs the row-to-row gaps a
// terminal with loose line spacing leaves through the code. Together they cost 10 columns:
// a 240-character invoice goes 51 wide to 61, still inside an 80-column terminal.
const QR_BORDER = 4
const QR_ECC = 'M'

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

// A QR is one character column per module, so how much fits is the terminal's width. Fall
// back to the 80 columns a terminal has when it will not say — piped output has no width,
// and guessing wide would print a code nothing can read anyway.
function terminalColumns() {
  return process.stderr.columns || 80
}

// Render to stderr — a QR is decoration next to the payload the caller has already put on
// stdout — and through the same direct write as note(), so it keeps its place in the run.
//
// Returns false without printing when the code would not fit across the terminal: a QR
// wrapped mid-row is not a smaller QR, it is noise, so say so and let the caller offer the
// text instead.
export function showQr(text, { ecc = QR_ECC } = {}) {
  const code = qrCode(text, { ecc })
  const columns = terminalColumns()
  if (code.width > columns) {
    note(`(QR needs ${code.width} columns, this terminal has ${columns})`)
    return false
  }
  for (const line of code.lines) write(`${line}\n`)
  return true
}

// The same code as lines, coloured and ready to place, with the width it needs — for a
// caller drawing it somewhere other than straight down stderr. The full-screen UI puts one
// in a pane and has to know whether it fits before it lays the pane out.
export function qrCode(text, { ecc = QR_ECC } = {}) {
  const width = encode(text, { border: QR_BORDER, ecc }).size + 2 * QR_BORDER
  // Two rows of modules per line of text, so the code stays roughly square.
  const rows = lightenLastRow(renderUnicodeCompact(text, { border: QR_BORDER, ecc }).split('\n'))
  return { width, lines: rows.map((line) => `${QR_LIGHT_ON_DARK}${line}${QR_RESET}`) }
}

// The invoice itself goes to stdout so `cashme deposit ... | ...` still yields just the
// bolt11 string; the QR is decoration and goes to stderr alongside the progress lines.
//
// bolt11 is bech32 and so case-insensitive, and an all-uppercase payload encodes in the QR
// alphanumeric mode rather than byte mode — about half the bits, which is the difference
// between a code that fits a terminal and one that does not. Wallets read the uppercase
// form; we still print the invoice as the mint gave it to us.
export function showInvoice(request) {
  note('pay lightning invoice:')
  console.log(request)
  showQr(request.toUpperCase())
}

// A token handed over out of band. The string goes to stdout, alone on its line, so it can
// be piped or copied; everything else the run says is on stderr.
//
// Unlike an invoice a token is base64url, so it is case-sensitive and encodes in byte mode
// — roughly 1.6x the bits per character. Error correction drops to L to buy back some of
// that: a couple of hundred bytes is all that fits across a terminal either way, so a
// single-proof token has a chance and a fat one does not. The caller is told when it does
// not fit, since the text above is still perfectly good.
export function showToken(token, { qr = false } = {}) {
  console.log(token)
  if (!qr) return true
  if (showQr(token, { ecc: 'L' })) return true
  note('the token is too long to show as a QR here — copy the text above instead')
  return false
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
function wholeAmount(value, flag) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`${flag} must be a positive whole number, got "${value}"`)
  }
  return amount
}

// `--sats` on the commands that have no --unit — `give`, `nutzap`, `zap` — where sats is
// the only thing being sent and the flag says so.
export function sats(value) {
  return wholeAmount(value, '--sats')
}

// `--amount` on `deposit`, where the number alone means nothing: --unit says what it counts.
export function amountFlag(value) {
  return wholeAmount(value, '--amount')
}

// `--unit`, normalized the way coco normalizes it so the flag and the wallet agree on what
// counts as the same unit. Which units exist is the mint's business, not ours — an unknown
// one fails at the mint, where the answer actually lives.
export function unitFlag(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_UNIT
  const unit = normalizeUnit(String(value), { defaultUnit: DEFAULT_UNIT })
  if (!unit) throw new Error(`--unit needs a unit name, got "${value}"`)
  return unit
}
