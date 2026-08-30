// Streams that behave like a terminal without being one, so a screen can be rendered and
// typed at from a test — or from a machine with no tty at all, which is where this started.
//
// `frames()` gives what was painted, one entry per repaint, with the escape sequences taken
// back out: what a test wants to assert on is the text the user would have seen.
import EventEmitter from 'bare-events'
import { strip } from './style.mjs'

// The cursor and erase sequences the runtime frames each paint with. strip() takes the
// colours out; these are what is left.
const CONTROL = /\x1b\[[0-9]*[HJK]/g

export class FakeStdout extends EventEmitter {
  constructor({ columns = 80, rows = 24 } = {}) {
    super()
    this.columns = columns
    this.rows = rows
    this.writes = []
    this.isTTY = true
  }

  write(chunk) {
    this.writes.push(String(chunk))
    return true
  }

  resize(columns, rows) {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }

  // Each repaint, as an array of lines with trailing blanks dropped.
  frames() {
    return this.writes
      .filter((chunk) => chunk.startsWith('\x1b[H'))
      .map((chunk) =>
        strip(chunk.replace(CONTROL, ''))
          .split('\r\n')
          .map((line) => line.replace(/\s+$/, ''))
      )
      .map((lines) => {
        while (lines.length && lines[lines.length - 1] === '') lines.pop()
        return lines
      })
  }

  // The last painted frame as one string, which is what most assertions want to search.
  screen() {
    const frames = this.frames()
    return frames.length ? frames[frames.length - 1].join('\n') : ''
  }
}

export class FakeStdin extends EventEmitter {
  constructor() {
    super()
    this.isTTY = true
    this.raw = false
  }

  setRawMode(enabled) {
    this.raw = enabled
    return this
  }

  pause() {}
  resume() {}

  // Types at the app. Give it what a terminal would send — 'q', '\x1b[B' for down, '\r'
  // for return.
  type(input) {
    this.emit('data', Buffer.from(input))
  }
}

// Renders have to settle before a test can look at them: state set in an effect paints on
// the next microtask, not this one. Awaiting this twice covers an effect that sets state
// which schedules another effect.
export function settled() {
  return new Promise((resolve) => setImmediate(resolve))
}
