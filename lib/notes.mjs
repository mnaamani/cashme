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

// Where the lines go when something other than a terminal wants them. The full-screen UI
// sets this: it owns every cell on the screen, so a stray write to stderr would land in the
// middle of a box and stay there until the next repaint. With a sink set, the same lines
// become the UI's activity log — the wallet keeps narrating itself, and the UI decides
// where that shows.
//
// Nothing else should set this. A command run from a shell writes to stderr, which is what
// makes `cashme give 2> log` work.
let sink = null

export function redirect(fn) {
  const previous = sink
  sink = fn
  return () => {
    sink = previous
  }
}

// A line, joined the way console.error joins its arguments.
export function note(...parts) {
  const line = parts.join(' ')
  if (sink) {
    sink(`${line}\n`)
    return
  }
  process.stderr.write(`${line}\n`)
}

// Part of a line: the progress dots, and the QR code's rows.
export function write(chunk) {
  if (sink) {
    sink(chunk)
    return
  }
  process.stderr.write(chunk)
}

// Resolves once everything written above has actually reached stderr. The empty write is
// there for its callback, which the stream only makes once the queue ahead of it drains.
export function flush() {
  // A sink is synchronous — there is no queue in front of it — so there is nothing to wait
  // for, and waiting on stderr here would be waiting on the wrong stream.
  if (sink) return Promise.resolve()
  return new Promise((resolve) => process.stderr.write('', resolve))
}
