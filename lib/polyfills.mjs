// coco, cashu-ts and @noble expect browser globals that Bare does not provide.
// This must be a separate module: within a single module all `import`s are evaluated
// before any statement in the body, so assigning to globalThis next to the imports is too
// late. Importing this module *above* the @cashu import is evaluated first — @noble reads
// TextEncoder while its own module body runs, so the order is not optional.
import 'bare-crypto/global'
import { TextEncoder, TextDecoder } from 'bare-encoding'
import bareFetch, { Headers, Request, Response } from 'bare-fetch'

globalThis.TextEncoder = TextEncoder
globalThis.TextDecoder = TextDecoder
globalThis.fetch = bareFetch
// coco builds request headers itself, so `Headers` has to be global too — cashu-ts on its
// own never touched it.
globalThis.Headers = Headers
globalThis.Request = Request
globalThis.Response = Response
