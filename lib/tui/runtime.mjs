// The part that behaves like Ink: components are functions, state lives in hooks, and a
// change anywhere re-renders the whole tree.
//
// There is no reconciler and no virtual DOM diff. The tree is re-expanded from the root
// every frame and the result is laid out into lines, which for a screenful of text costs
// nothing worth measuring — a terminal is a few thousand cells, not a document. What that
// buys is that there is no component instance to keep in sync with the tree: the only
// thing that survives a frame is hook state, keyed by where the component sits.
//
// Which is also the one rule this shares with React and cannot bend: hooks are matched by
// call order within a component, and components by their path in the tree. Call a hook
// inside a condition and it takes the state of whichever hook was there last frame. Render
// a list without keys and reordering it moves state between rows.
import tty from 'bare-tty'
import process from 'bare-process'
import { isElement, HOST_TYPES } from './element.mjs'
import { render as layout, fit } from './layout.mjs'
import { decode } from './keys.mjs'

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'
const CURSOR_HIDE = '\x1b[?25l'
const CURSOR_SHOW = '\x1b[?25h'
const HOME = '\x1b[H'
const CLEAR_LINE = '\x1b[K'
const CLEAR_BELOW = '\x1b[J'

// The component being expanded right now: which runtime it belongs to, and where in the
// tree it sits. Module state rather than an argument, because hooks are called by the
// component, which is given only its props.
let current = null

class Runtime {
  constructor(root, { stdout, stdin, onError }) {
    this.root = root
    this.stdout = stdout
    this.stdin = stdin
    this.onError = onError

    this.hooks = new Map() // path -> { hooks: [], seen: boolean }
    this.effects = [] // queued for after the frame is on screen
    this.inputs = [] // useInput handlers, rebuilt every frame
    this.frame = null // last thing written, so an unchanged frame is not rewritten
    this.rendering = false
    this.scheduled = false
    this.exited = false
    this.path = ''

    this.exit = null // resolves waitUntilExit()
    this.done = new Promise((resolve) => {
      this.exit = resolve
    })
  }

  // --- hooks -------------------------------------------------------------------

  // Every hook goes through here: it finds this component's slot list and advances the
  // cursor, so the nth call in a component always reads the nth slot.
  slot(initial) {
    const state = this.hooks.get(current.path)
    const index = current.index++
    if (state.hooks.length <= index) state.hooks.push({ value: initial() })
    return state.hooks[index]
  }

  schedule() {
    if (this.exited || this.scheduled) return
    this.scheduled = true
    // A microtask, so a handler that sets three pieces of state paints one frame rather
    // than three.
    Promise.resolve().then(() => {
      this.scheduled = false
      this.draw()
    })
  }

  // --- rendering ---------------------------------------------------------------

  // Resolve function components until only host elements are left. `path` identifies a
  // component across frames — its position among its siblings, or its key when it has one.
  expand(node, path) {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (!isElement(node)) return null

    if (typeof node.type === 'function') {
      const own = `${path}/${node.type.name || 'anon'}`
      let state = this.hooks.get(own)
      if (!state) {
        state = { hooks: [], seen: true }
        this.hooks.set(own, state)
      }
      state.seen = true

      const previous = current
      current = { runtime: this, path: own, index: 0 }
      let produced
      try {
        produced = node.type({ ...node.props, children: node.children })
      } finally {
        current = previous
      }
      return this.expand(produced, own)
    }

    if (!HOST_TYPES.has(node.type)) throw new Error(`unknown element type: ${node.type}`)

    return {
      type: node.type,
      props: node.props,
      children: node.children
        .map((child, index) => this.expand(child, `${path}/${node.key ?? index}`))
        .filter((child) => child !== null)
    }
  }

  draw() {
    if (this.exited || this.rendering) return
    this.rendering = true
    try {
      for (const state of this.hooks.values()) state.seen = false
      this.inputs = []

      const tree = this.expand(this.root, '')
      this.sweep()
      this.paint(tree)
      this.flushEffects()
    } catch (err) {
      this.rendering = false
      this.fail(err)
      return
    }
    this.rendering = false
  }

  // Components that were not reached this frame are gone: run their effect cleanups and
  // drop their state, so remounting one starts fresh rather than resuming a screen the
  // user has left.
  sweep() {
    for (const [path, state] of this.hooks) {
      if (state.seen) continue
      for (const slot of state.hooks) {
        if (typeof slot.cleanup === 'function') this.guard(slot.cleanup)
        slot.cleanup = null
      }
      this.hooks.delete(path)
    }
  }

  // The frame's size, which is one short of the terminal's in both directions.
  //
  // A row short because writing the last cell of the last row makes some terminals scroll,
  // which on the alternate screen shifts the whole frame up.
  //
  // A column short for the same family of reasons at the other edge: writing the last cell
  // of a line leaves the cursor against the right margin with a wrap pending, which
  // terminals resolve differently, and an overlay scrollbar sits on that column and hides
  // whatever is under it — which for this UI is every box's right border. Neither is worth
  // one column of width.
  size() {
    return {
      columns: Math.max(1, (this.stdout.columns || 80) - 1),
      rows: Math.max(1, (this.stdout.rows || 24) - 1)
    }
  }

  paint(tree) {
    const { columns, rows } = this.size()
    const lines = fit(layout(tree, columns), rows, columns)
    const frame = HOME + lines.map((line) => line + CLEAR_LINE).join('\r\n') + CLEAR_BELOW
    if (frame === this.frame) return
    this.frame = frame
    this.stdout.write(frame)
  }

  // Effects run after the frame is on screen, the way they run after a commit in React —
  // an effect that starts a wallet operation should not delay the screen that says it is
  // starting.
  flushEffects() {
    const queued = this.effects
    this.effects = []
    for (const effect of queued) {
      this.guard(() => {
        const cleanup = effect.fn()
        effect.slot.cleanup = typeof cleanup === 'function' ? cleanup : null
      })
    }
  }

  // --- input -------------------------------------------------------------------

  onkey(chunk) {
    for (const event of decode(chunk)) {
      // Newest first: a modal registers its handler deeper in the tree, and gets the key
      // before the screen underneath it. `stop()` is how it keeps it.
      let stopped = false
      const stop = () => {
        stopped = true
      }
      for (const handler of [...this.inputs].reverse()) {
        this.guard(() => handler(event, { stop }))
        if (stopped) break
      }
    }
  }

  // --- lifetime ----------------------------------------------------------------

  guard(fn) {
    try {
      fn()
    } catch (err) {
      this.fail(err)
    }
  }

  // The error is what `render()` resolves with when nobody else is listening, so it has to
  // be the value unmount() settles on — unmounting first and reporting after would resolve
  // the promise with nothing and lose the error on the way out.
  fail(err) {
    if (this.exited) return
    if (!this.onError) return this.unmount(err)
    this.unmount()
    this.onError(err)
  }

  unmount(value) {
    if (this.exited) return
    this.exited = true
    for (const state of this.hooks.values()) {
      for (const slot of state.hooks) {
        if (typeof slot.cleanup === 'function') {
          try {
            slot.cleanup()
          } catch {
            // Nothing useful to do while tearing down, and the terminal still has to be
            // put back.
          }
        }
      }
    }
    this.hooks.clear()
    this.restore()
    this.exit(value)
  }

  restore() {
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(false)
      this.stdin.pause()
    } catch {
      // The stream may already be gone; the escape codes below matter more.
    }
    this.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF)
  }
}

// --- the hooks themselves --------------------------------------------------------

function runtimeOf() {
  if (!current) throw new Error('hooks can only be called while a component is rendering')
  return current.runtime
}

export function useState(initial) {
  const runtime = runtimeOf()
  const slot = runtime.slot(() => (typeof initial === 'function' ? initial() : initial))
  // Bound to the slot, not to a render, so a setter captured in a callback stays valid.
  if (!slot.set) {
    slot.set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      runtime.schedule()
    }
  }
  return [slot.value, slot.set]
}

export function useRef(initial) {
  const runtime = runtimeOf()
  const slot = runtime.slot(() => ({ current: initial }))
  return slot.value
}

export function useMemo(fn, deps) {
  const runtime = runtimeOf()
  const slot = runtime.slot(() => ({ deps: null, value: undefined, first: true }))
  if (slot.value.first || changed(slot.value.deps, deps)) {
    slot.value = { deps, value: fn(), first: false }
  }
  return slot.value.value
}

// Runs after the frame it was declared in reaches the screen, and again whenever `deps`
// change. Returning a function makes it the cleanup, run before the next run and on
// unmount — cancel a poll, close a swarm, stop a timer.
export function useEffect(fn, deps) {
  const runtime = runtimeOf()
  const slot = runtime.slot(() => null)
  if (slot.hasRun && !changed(slot.deps, deps)) return
  if (typeof slot.cleanup === 'function') runtime.guard(slot.cleanup)
  slot.cleanup = null
  slot.hasRun = true
  slot.deps = deps
  runtime.effects.push({ fn, slot })
}

// A key handler for as long as this component is on screen. `active: false` is how a
// screen behind a modal stops listening without unmounting.
export function useInput(handler, { active = true } = {}) {
  const runtime = runtimeOf()
  const slot = runtime.slot(() => ({}))
  slot.value.handler = handler
  if (active) runtime.inputs.push((event, api) => slot.value.handler(event, api))
}

// The terminal's size, kept current across resizes.
export function useSize() {
  const runtime = runtimeOf()
  // The size the frame is actually painted at, not the terminal's own — a screen that laid
  // itself out a column wider than the paint would have that column cut off it.
  const [size, setSize] = useState(() => runtime.size())
  useEffect(() => {
    const onresize = () => setSize(runtime.size())
    runtime.stdout.on('resize', onresize)
    return () => runtime.stdout.off('resize', onresize)
  }, [])
  return size
}

// `exit(value)` ends the app and resolves what `render()` returned, which is how a screen
// hands a result back to the command that launched it.
export function useApp() {
  const runtime = runtimeOf()
  return useMemo(
    () => ({
      exit: (value) => runtime.unmount(value),
      stdout: runtime.stdout
    }),
    []
  )
}

function changed(previous, next) {
  if (!previous || !next) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

// --- mounting --------------------------------------------------------------------

// Takes over the terminal, draws `element`, and resolves with whatever `exit()` was given.
// The terminal is put back on every path out — a thrown effect, a signal, a clean exit —
// because a process that dies on the alternate screen with the cursor hidden leaves a
// shell the user has to reset by hand.
export function render(element, { stdout, stdin, onError } = {}) {
  const out = stdout || new tty.WriteStream(1)
  const input = stdin || new tty.ReadStream(0)

  const runtime = new Runtime(element, { stdout: out, stdin: input, onError })

  out.write(ALT_SCREEN_ON + CURSOR_HIDE)
  if (input.isTTY) input.setRawMode(true)

  const onkey = (chunk) => runtime.onkey(chunk)
  const onresize = () => {
    runtime.frame = null // the old frame is the wrong shape; force a full repaint
    runtime.draw()
  }
  // Raw mode delivers Ctrl-C as a keystroke rather than a signal, so these are the ones
  // that still arrive from outside: a kill, or the terminal window closing.
  const onsignal = () => runtime.unmount()

  input.on('data', onkey)
  out.on('resize', onresize)
  process.on('SIGTERM', onsignal)
  process.on('SIGHUP', onsignal)

  runtime.draw()

  const finished = runtime.done.finally(() => {
    input.off('data', onkey)
    out.off('resize', onresize)
    process.off('SIGTERM', onsignal)
    process.off('SIGHUP', onsignal)
  })

  return {
    waitUntilExit: () => finished,
    unmount: (value) => runtime.unmount(value),
    rerender: () => runtime.schedule()
  }
}
