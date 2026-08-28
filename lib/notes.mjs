// Everything a run says about itself, on one write path.
//
// Bare gives stderr two of them — console.error, which lands immediately, and
// process.stderr.write, which queues — and a run that uses both prints its lines out of
// order: a console.error issued after a queued write still overtakes it. Partial lines are
// only possible through the queue (the poll dots below), so the queue is the path
// everything takes, and console.error is not used for stderr anywhere in this codebase.
//
// The queue also means the last lines of a run are still unwritten when it ends, and
// Bare.exit() drops them — so a run has to flush() before it exits.
import process from 'bare-process'

// A line, joined the way console.error joins its arguments.
export function note(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`)
}

// Part of a line: the progress dots, and the QR code's rows.
export function write(chunk) {
  process.stderr.write(chunk)
}

// Resolves once everything written above has actually reached stderr. The empty write is
// there for its callback, which the stream only makes once the queue ahead of it drains.
export function flush() {
  return new Promise((resolve) => process.stderr.write('', resolve))
}
