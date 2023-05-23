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
  .option('-s, --slots <n>', 'number of slots to run for', '10')
  .option('-d, --delay <secs>', 'number of seconds after slot boundary to submit transactions', '3')
  .option('-t, --txns <n>', 'average number of transactions to aim to submit per slot', '2')
  .option('-m, --max-txns <n>', 'maximum transactions to submit per slot', '8')
  .option('-c, --contract <addr>', 'transaction recipient', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  .option('-f, --fee-mult <n>', 'base fee multiplier', '2')
  .option('-g, --gas-mult <n>', 'gas limit multiplier', '2')
  .option('-p, --priority-fee <gwei>', 'max priority fee per gas', '10')
  .option('-i, --interval <millis>', 'polling interval', '500')
  .requiredOption('-k, --signer <key>', 'private key of account to send transactions from')
program.parse()
const options = program.opts()

const fetchRequest = new ethers.FetchRequest(options.rpc)
options.header.forEach((v, k) => fetchRequest.setHeader(k, v))
const provider = new ethers.JsonRpcProvider(fetchRequest)
const pollingInterval = parseInt(options.interval)
provider.pollingInterval = pollingInterval
console.log('Awaiting network...')
const network = await provider.getNetwork()
console.log(`Got ${network.name}`)
const signer = new ethers.Wallet(options.signer, provider)
console.log(`Signer: ${await signer.getAddress()}`)
console.log(`Balance: ${ethers.formatEther(await provider.getBalance(signer))} ether`)
let nonce = await signer.getNonce()
console.log(`Nonce: ${nonce}`)

let slotsLeft = parseInt(options.slots)
const total = parseInt(options.txns) * slotsLeft
const delay = parseInt(options.delay)
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
let landed = 0

const startBlock = await provider.getBlockNumber()
const block = await provider.getBlock(startBlock)
console.log(`Block: ${startBlock}`)

let checkWaiting
let slot
let lastSeenBlockNumber = 0
let feeBlockNumber = lastSeenBlockNumber
let fastFee = block.baseFeePerGas * feeMult
let gasLimit

async function processSubmitted() {
  while (submitted.length && Promise.race([submitted[0], false])) {
    const receipt = await submitted.shift()
    console.log(`${nonces.get(receipt.hash)} (${shortHash(receipt.hash)}) included in ${receipt.blockNumber}`)
    landed += 1
    if (receipt.blockNumber > lastSeenBlockNumber) {
      lastSeenBlockNumber = receipt.blockNumber
    }
  }
  checkWaiting = false
}

async function processSlot() {
  if (!slotsLeft) return
  console.log(`Processing slot ${slot}`)
  console.log(`Fast fee: ${ethers.formatUnits(fastFee, 'gwei')} gwei`)
  const toSubmit = Math.min(maxTxns, Math.trunc((total - landed) / slotsLeft))
  for (const i of Array(toSubmit).keys()) {
    const tx = makeTxn(fastFee, nonce)
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
    nonce = response.nonce + 1
    submitted.push(response.wait())
  }
  slotsLeft -= 1
}

const GENESIS = 1606824023

const now = Math.trunc(Date.now() / 1000)
let seconds = (now - (now % 12) - 1 - GENESIS)
slot = seconds / 12

async function everySecond() {
  console.log(`${Date.now()}: ${seconds} s`)
  checkWaiting = true
  if (seconds % 12 === 11) slot += 1
  seconds += 1
  if (seconds % 12 === delay)
    await processSlot()
}

let intervalId = setInterval(everySecond, 1000)

while (submitted.length || slotsLeft) {
  if (checkWaiting) await processSubmitted()
  else if (feeBlockNumber < lastSeenBlockNumber) {
    feeBlockNumber = lastSeenBlockNumber
    const block = await provider.getBlock(feeBlockNumber)
    fastFee = block.baseFeePerGas * feeMult
  }
  else await new Promise(resolve => setTimeout(resolve, 250))
}

clearInterval(intervalId)
