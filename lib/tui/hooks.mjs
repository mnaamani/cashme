// Hooks that are about time and work rather than about drawing.
//
// A screen never awaits anything at render time — a component runs to completion and
// returns elements. Anything that takes a moment is started in an effect and reported back
// through state, which is what useTask is: one wallet operation, its progress, and what
// became of it, in a shape a pane can be drawn from.
import { useState, useEffect, useRef, useMemo } from './runtime.mjs'

// A timer that is cleared when the component leaves, so a spinner on a screen the user has
// navigated away from stops rather than repainting an invisible frame forever.
export function useInterval(fn, ms) {
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    if (ms === null) return
    const timer = setInterval(() => latest.current(), ms)
    return () => clearInterval(timer)
  }, [ms])
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function useSpinner(active = true) {
  const [frame, setFrame] = useState(0)
  useInterval(() => setFrame((f) => (f + 1) % FRAMES.length), active ? 80 : null)
  return active ? FRAMES[frame] : ' '
}

// One unit of work, and the four things a screen needs to say about it: not started,
// running, what came back, what went wrong.
//
// `run` is stable across renders, so it can be handed to a key handler. Calling it while
// the previous run is still going is refused rather than queued — two melts started by an
// impatient double-press would both reserve proofs.
export function useTask(fn, { onDone } = {}) {
  const [state, setState] = useState({ status: 'idle', result: null, error: null, note: null })
  const alive = useRef(true)
  const running = useRef(false)
  const latest = useRef({ fn, onDone })
  latest.current = { fn, onDone }

  useEffect(() => {
    alive.current = true
    // A wallet operation cannot be called back once started, so this does not cancel it —
    // it stops the result being written into state that no longer exists.
    return () => {
      alive.current = false
    }
  }, [])

  const api = useMemo(
    () => ({
      run: (...args) => {
        if (running.current) return null
        running.current = true
        setState({ status: 'running', result: null, error: null, note: null })
        // Progress the operation reports on its way, for the pane to show while it waits.
        const say = (note) => {
          if (alive.current) setState((previous) => ({ ...previous, note }))
        }
        const promise = Promise.resolve()
          .then(() => latest.current.fn(...args, { say }))
          .then(
            (result) => {
              running.current = false
              if (!alive.current) return result
              setState({ status: 'done', result, error: null, note: null })
              latest.current.onDone?.(result)
              return result
            },
            (error) => {
              running.current = false
              if (alive.current) {
                setState({ status: 'error', result: null, error, note: null })
              }
              // Swallowed on purpose: the error is on screen, and rethrowing here would
              // reach nobody but the unhandled-rejection handler.
              return null
            }
          )
        return promise
      },
      reset: () => {
        if (!running.current) setState({ status: 'idle', result: null, error: null, note: null })
      }
    }),
    []
  )

  return { ...state, ...api, busy: state.status === 'running' }
}

// Runs `fn` when the component mounts and whenever `deps` change, and again on demand.
// Used for the readings a screen shows rather than the operations it starts: balances,
// pending sends.
export function usePoll(fn, deps = [], { every = null } = {}) {
  const [value, setValue] = useState(null)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let stale = false
    Promise.resolve()
      .then(fn)
      .then(
        (next) => {
          if (!stale && alive.current) {
            setValue(next)
            setError(null)
          }
        },
        (err) => {
          if (!stale && alive.current) setError(err)
        }
      )
    return () => {
      stale = true
    }
  }, [...deps, tick])

  useInterval(() => setTick((t) => t + 1), every)

  return { value, error, refresh: () => setTick((t) => t + 1) }
}
