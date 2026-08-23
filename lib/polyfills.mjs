// cashu-ts needs global fetch and TextEncoder APIs.
// This must be a separate module: within a single module all `import`s are evaluated
// before any statement in the body, so assigning to globalThis next to the imports is
// too late. Importing this module *above* the cashu-ts import is evaluated first.
import 'bare-crypto/global'
import { TextEncoder } from 'text-encoding'
import bareFetch from 'bare-fetch'

globalThis.TextEncoder = TextEncoder
globalThis.fetch = bareFetch
