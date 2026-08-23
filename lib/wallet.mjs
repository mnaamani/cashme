import DHT from 'hyperdht'
import HttpBridgeClient from '@dhttp/client'
import 'bare-crypto/global'

// cashu-ts needs global fetch and TextEncoder APIs
import { TextEncoder } from 'text-encoding'
globalThis.TextEncoder = TextEncoder

import bareFetch from 'bare-fetch'
globalThis.fetch = bareFetch
// import Wallet only after setting TextEncoder and fetch on globalThis
import {
  Wallet,
  MintQuoteState,
  getEncodedToken,
  getTokenMetadata,
  serializeProofs,
  deserializeProofs
} from '@cashu/cashu-ts'
import { writeFileSync, readFileSync } from 'bare-fs'

const testnutBridgeKey = '72c402ee132faddfc8d24141daeed4c91fe5f7ce873d49095f6225330a7b8ba7'
const dht = new DHT()
const dhttpclient = new HttpBridgeClient(dht.connect(testnutBridgeKey))

const { upstream } = await dhttpclient.info()
console.log('Connected to mint bridge:', testnutBridgeKey)
console.log('Upstream:', upstream)

// TODO: add a bridgekey -> expected upstream url map to check against.
// TODO: We also need reverse mapping to lookup bridgekey from mintUrl if we choose to use the real
// url in the encoded tokens.
if (upstream !== 'https://testnut.cashu.space/') {
  // we used incorrect bridge key for the expected upstream mint
  // keep in mind the upstream is self reported by the bridge.. it can still lie,
  // this is just local check, it is on the user to make sure they are using correct bridge key.
  console.log('Unexpected upstream')
}
// now swapout global fetch for the client's fetch, not this means any other part of the app
// that uses global fetch will be talking to the mint!
globalThis.fetch = dhttpclient.fetch()

// The real mint url is the upstream the bridge connects to. Passing a different
// url to the Wallet constructor doesn't change the destination
const wallet = new Wallet(upstream, {
  // These custom transport options don't seem to be working..why?
  // requestFetch: dhttpclient.fetch(),
  // customRequest: dhttpclient.fetch(),
  // OpenId Authentication - needs to reach 'normal' internet, can't use the global fetch
  // we have overriden to call the mint.
  oidc: {
    fetch: bareFetch
  },
  unit: 'sat'
})
await wallet.loadMint() // wallet is now ready to use
const mintInfo = wallet.getMintInfo()
console.log('Wallet Ready.\n')
console.log(`${mintInfo.name} - ${mintInfo.description} - ${wallet.mint.mintUrl}`)

const proofs = await mintTokens(10, wallet.mint.mintUrl)
const token = getEncodedToken({ mint: upstream, proofs })
console.log(token)

console.log('sent!') // send the token over ble! ;)

const meta = getTokenMetadata(token)
console.log(meta.mint) // check we are using same mint, or we have to create a separate wallet instance
console.log(meta.unit)
console.log(meta.amount.toNumber())
// swap the proofs at the mint for fresh ones as soon as possible.
const receivedProofs = await wallet.receive(token)
console.log('received!')
console.log(JSON.stringify(receivedProofs))

// TODO if time permits
// "swap the token for real bitcoin over lightning (ie. melt the tokens at the mint, and the mint pays a lightning invoice"
// https://github.com/cashubtc/cashu-ts/blob/main/docs-src/usage/melt_token.md

dhttpclient.destroy()
await dht.destroy()

// Generate fresh encoded token funded by lightning payment
async function mintTokens(amount) {
  console.log(`minting ${amount} tokens`)
  const mintQuote = await wallet.createMintQuoteBolt11(amount)
  console.log('invoice', mintQuote)
  // when using the testnut mint, the bolt11 invoice should be automatically paid on the mint side
  await sleepSeconds(5)
  // display QR code of the invoice or plain string to user and ask them to pay it.
  // promt user to press enter when they have paid invoice..check then prompt again if still UNPAID until they abort (Ctrl-C)
  const mintQuoteChecked = await wallet.checkMintQuoteBolt11(mintQuote.quote)
  console.log(`invoice state: ${mintQuoteChecked.state}`)
  if (mintQuoteChecked.state === MintQuoteState.PAID) {
    return await wallet.mintProofsBolt11(amount, mintQuote.quote)
  }
}

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}
