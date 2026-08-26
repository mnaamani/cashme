// Must come first: coco pulls in @noble, which needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import { normalizeMintUrl } from '../lib/mint-url.mjs'

test('mint urls are normalized down to one identity', (t) => {
  t.is(normalizeMintUrl('https://Mint.Example.COM/'), 'https://mint.example.com')
  // coco strips one trailing slash, not all of them; we match it rather than tidy further.
  t.is(normalizeMintUrl('https://mint.example.com//'), 'https://mint.example.com/')
  t.is(normalizeMintUrl('HTTPS://MINT.EXAMPLE.COM/Path/'), 'https://mint.example.com/Path')
  t.is(normalizeMintUrl('https://mint.example.com:443/'), 'https://mint.example.com')
})

// Mint urls come out of tokens, which anyone can hand us. coco's own normalizer accepts
// all of these; ours must not.
test('a mint url that is not a plain http(s) address is refused', (t) => {
  t.exception.all(() => normalizeMintUrl('ftp://mint.example.com'), /scheme/)
  t.exception.all(() => normalizeMintUrl('file:///etc/passwd'), /scheme/)
  t.exception.all(() => normalizeMintUrl('https://user:pass@mint.example.com'), /credentials/)
  t.exception.all(() => normalizeMintUrl('https://mint.example.com?evil=1'), /query/)
  t.exception.all(() => normalizeMintUrl('https://mint.example.com#evil'), /fragment/)
  t.exception.all(() => normalizeMintUrl('not a url'), 'garbage is not a mint')
})
