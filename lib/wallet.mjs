import './polyfills.mjs'
import { Wallet, MintQuoteState, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts'

const testnutMintUrl = 'https://testnut.cashu.space/'
export async function openWallet() {
  const wallet = new Wallet(testnutMintUrl)
  await wallet.loadMint() // wallet is now ready to use
  return { wallet }
}

// Generate new tokens funded by lightning payment
export async function mintTokens(wallet, amount) {
  console.error(`minting ${amount}${wallet.unit}`)
  const mintQuote = await wallet.createMintQuoteBolt11(amount)
  console.log('pay lightning invoice:', mintQuote.request)
  // when using the testnut mint, the bolt11 invoice should be automatically paid on the mint side
  // display QR code of the invoice or plain string to user and ask them to pay it.
  // keep polling the mint until the invoice is paid, until the user aborts (Ctrl-C)
  while (true) {
    await sleepSeconds(5)
    const mintQuoteChecked = await wallet.checkMintQuoteBolt11(mintQuote.quote)
    if (mintQuoteChecked.state === MintQuoteState.PAID) break
    console.error(`invoice not paid yet (${mintQuoteChecked.state}), waiting...`)
  }
  console.error('Invoice paid.')
  const proofs = await wallet.mintProofsBolt11(amount, mintQuote.quote)
  return proofs
}

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export async function processToken(wallet, token) {
  console.error('processing token', token)
  const meta = getTokenMetadata(token)
  console.error(meta.mint)
  console.error(meta.unit)
  console.error(meta.amount.toNumber())
  // normalize urls to handle cases of trailing backslash '/' ?
  // Thats the wrong question, instead create a Wallet for the mint specified in the metadata!
  // this is temporary until we get to fixing the proof store to handle multiple mints
  if (wallet.mint.mintUrl !== meta.mint) {
    throw new Error('Wallet mint differs from token metadata')
  }
  // swap the proofs at the mint for fresh ones as soon as possible.
  const receivedProofs = await wallet.receive(token)
  return receivedProofs // + also return the minturl
}

export async function generateTokenToSend(wallet, amount, proofs) {
  const { keep, send } = await wallet.send(amount, proofs)
  const token = getEncodedToken({ mint: wallet.mint.mintUrl, proofs: send })
  return { token, keep }
}

/*
// TODO if time permits
// "swap the token for real bitcoin over lightning (ie. melt the tokens at the mint, and the mint pays a lightning invoice"
// https://github.com/cashubtc/cashu-ts/blob/main/docs-src/usage/melt_token.md
*/
