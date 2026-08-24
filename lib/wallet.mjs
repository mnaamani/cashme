import './polyfills.mjs'
import { Wallet, MintQuoteState, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts'

const testnutMintUrl = 'https://testnut.cashu.space/'
export async function openWallet(mintUrl = testnutMintUrl) {
  const wallet = new Wallet(mintUrl, {
    unit: 'sat'
  })
  await wallet.loadMint() // wallet is now ready to use
  const mintInfo = wallet.getMintInfo()
  console.log('Wallet Ready.\n')
  console.log(`${mintInfo.name} - ${mintInfo.description} - ${wallet.mint.mintUrl}`)
  return { wallet }
}

// Generate fresh encoded token funded by lightning payment
export async function mintTokens(wallet, amount) {
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

export async function processToken(wallet, token) {
  console.log('processing token', token)
  const meta = getTokenMetadata(token)
  console.log(meta.mint) // check we are using same mint, or we have to create a separate wallet instance
  console.log(meta.unit)
  console.log(meta.amount.toNumber())
  // swap the proofs at the mint for fresh ones as soon as possible.
  const receivedProofs = await wallet.receive(token)
  console.log('received!')
  return receivedProofs
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
