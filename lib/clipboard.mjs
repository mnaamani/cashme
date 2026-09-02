// The system clipboard, which Bare has no notion of: on every platform it is a program you
// pipe into.
import { spawn } from 'bare-subprocess'
import { isMac, isWindows } from 'which-runtime'

// In preference order; the first one installed wins. Linux has no single answer — wl-copy
// under wayland, xclip or xsel under X11 — and a headless box has none of them, which is
// why this reports what it managed rather than assuming.
const COPIERS = isMac
  ? [['pbcopy', []]]
  : isWindows
    ? [['clip', []]]
    : [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']]
      ]

// The other direction. Reading is a different program from writing on every platform
// except Windows, where it is powershell either way — and powershell adds a trailing
// newline of its own, which trim() below takes back off.
const PASTERS = isMac
  ? [['pbpaste', []]]
  : isWindows
    ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
    : [
        ['wl-paste', ['--no-newline']],
        ['xclip', ['-selection', 'clipboard', '-o']],
        ['xsel', ['--clipboard', '--output']]
      ]

// A clipboard program that never exits would hold the wallet lock with it, so stop waiting
// and move on. Generous, because these are all local and instant when they work at all.
const COPY_TIMEOUT = 5000

// Returns the program that took the text, or null when nothing here could. Never throws: a
// clipboard that will not cooperate must not cost the caller its token.
export async function copyToClipboard(text) {
  for (const [file, args] of COPIERS) {
    try {
      await pipeInto(file, args, text)
      return file
    } catch {
      // Not installed, not allowed to run, or too slow: try the next one.
    }
  }
  return null
}

// Returns what the clipboard held, or null when nothing here could read it — which is a
// different answer from '' and has to stay one: an empty clipboard is worth saying so
// about, and no clipboard tool is worth saying something else about.
export async function pasteFromClipboard() {
  for (const [file, args] of PASTERS) {
    try {
      return (await readFrom(file, args)).trim()
    } catch {
      // Not installed, not allowed to run, or too slow: try the next one.
    }
  }
  return null
}

// What to suggest when none of them worked, so the message names something the user could
// actually install rather than 'a clipboard tool'.
export const CLIPBOARD_PROGRAMS = COPIERS.map(([file]) => file).join(', ')
export const CLIPBOARD_READERS = PASTERS.map(([file]) => file).join(', ')

// Waits for 'close' rather than 'exit': the child is gone either way, but the pipes are
// only released on close, and a handle nobody closes keeps the loop alive.
function pipeInto(file, args, text) {
  return new Promise((resolve, reject) => {
    let child
    // spawn throws ENOENT here rather than emitting it, so both paths need catching.
    try {
      child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch (err) {
      return reject(err)
    }

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} did not finish`))
    }, COPY_TIMEOUT)

    const settle = (err) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }

    child.on('error', settle)
    child.stdin.on('error', settle)
    child.on('close', (code) =>
      settle(code === 0 ? null : new Error(`${file} exited with ${code}`))
    )
    child.stdin.end(text)
  })
}

// The reading half of pipeInto. Same lifetime rules — 'close' rather than 'exit', and a
// timeout — with stdout collected instead of stdin written.
function readFrom(file, args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      return reject(err)
    }

    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} did not finish`))
    }, COPY_TIMEOUT)

    const settle = (err, value) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }

    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', (err) => settle(err))
    child.stdout.on('error', (err) => settle(err))
    // xclip exits non-zero on an empty selection, which is not a failure to read — it is a
    // successful read of nothing, and the caller says so rather than falling through to the
    // next program and reporting there is no clipboard here at all.
    child.on('close', (code) =>
      settle(code === 0 || out !== '' ? null : new Error(`${file} exited with ${code}`), out)
    )
  })
}
