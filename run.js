import { ethers } from 'ethers'
import { program } from 'commander'
import { randomBytes } from 'node:crypto'

function addHeader(opt, headers) {
  const a = opt.split(':', 2)
  headers.set(a[0], a[1])
  return headers
}

program
  .option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
  .option('--header <k>:<v>', 'add a header to fetch requests, may be repeated', addHeader, new Map())
  .option('-z, --size <kB>', 'calldata kilobytes to include per transaction', '64')
  .option('--trim-bytes <b>', 'trim a few bytes from the size', '256')
  .option('-b, --blocks <n>', 'number of blocks to run for', '10')
  .option('-t, --txns <n>', 'average number of transactions to aim to submit per block', '2')
  .option('-m, --max-txns <n>', 'maximum transactions to submit per block', '8')
  .option('-c, --contract <addr>', 'transaction recipient', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  .option('-f, --fee-mult <n>', 'base fee multiplier', '2')
  .option('-g, --gas-mult <n>', 'gas limit multiplier', '2')
  .option('-p, --priority-fee <gwei>', 'max priority fee per gas', '10')
  .requiredOption('-s, --signer <key>', 'private key of account to send transactions from')
program.parse()
const options = program.opts()

const fetchRequest = new ethers.FetchRequest(options.rpc)
options.header.forEach((v, k) => fetchRequest.setHeader(k, v))
const provider = new ethers.JsonRpcProvider(fetchRequest)
console.log('Awaiting network...')
const network = await provider.getNetwork()
console.log(`Got ${network.name}`)
const signer = new ethers.Wallet(options.signer, provider)
console.log(`Using signer ${await signer.getAddress()}`)

let blocksLeft = parseInt(options.blocks)
let txnsLeft = parseInt(options.txns)
const maxTxns = parseInt(options.maxTxns)
const sizeBytes = parseInt(options.size) * 1024 - parseInt(options.trimBytes)
const feeMult = BigInt(options.feeMult)
const gasMult = BigInt(options.gasMult)
const prioFee = ethers.parseUnits(options.priorityFee, 'gwei')

function makeTxn(maxFee, nonce) {
  const tx = new ethers.Transaction()
  tx.chainId = network.chainId
  tx.maxFeePerGas = maxFee
  tx.maxPriorityFeePerGas = prioFee
  tx.nonce = nonce
  tx.to = options.contract
  tx.data = `0x${randomBytes(sizeBytes).toString('hex')}`
  return tx
}

const shortHash = (hash) => `${hash.substring(0, 4)}..${hash.substring(hash.length - 4)}`
const nonces = new Map()

const submitted = []
provider.on('block', async (blockNumber) => {
  while (submitted.length && Promise.race([submitted[0], false])) {
    const receipt = await submitted.shift()
    console.log(`${nonces.get(receipt.hash)} (${shortHash(receipt.hash)}) included in ${receipt.blockNumber}`)
  }
  if (!txnsLeft || !blocksLeft) {
    if (submitted.length) return
    else process.exit(0)
  }
  console.log(`Got block ${blockNumber}`)
  const block = await provider.getBlock(blockNumber)
  const baseFee = block.baseFeePerGas
  console.log(`Base fee: ${ethers.formatUnits(baseFee, 'gwei')} gwei`)
  const fastFee = baseFee * feeMult
  console.log(`Fast fee: ${ethers.formatUnits(fastFee, 'gwei')} gwei`)
  const startingNonce = await signer.getNonce()
  const toSubmit = Math.min(maxTxns, Math.trunc(txnsLeft / blocksLeft))
  let gasLimit = null
  for (const i of Array(toSubmit).keys()) {
    const tx = makeTxn(fastFee, startingNonce + i)
    if (!gasLimit) {
      tx.gasLimit = block.gasLimit
      gasLimit = gasMult * await signer.estimateGas(tx)
    }
    tx.gasLimit = gasLimit
    const popTx = await signer.populateTransaction(tx)
    const signedTx = await signer.signTransaction(popTx)
    const response = await provider.broadcastTransaction(signedTx)
    console.log(`Submitted ${response.nonce} as ${shortHash(response.hash)}`)
    nonces.set(response.hash, response.nonce)
    submitted.push(response.wait())
    txnsLeft -= 1
  }
  blocksLeft -= 1
})
