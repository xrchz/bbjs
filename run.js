import { ethers } from 'ethers'
import { program } from 'commander'
import { randomBytes } from 'node:crypto'

function addHeader(opt, headers) {
  const a = opt.split(':', 3)
  if (a.length === 2) a.unshift('*')
  if (!headers.has(a[0]))
    headers.set(a[0], new Map())
  const m = headers.get(a[0])
  m.set(a[1], a[2])
  return headers
}

function addRPC(opt, rpcs) {
  rpcs.push(opt)
  return rpcs
}

const getSigners = s => s.split(',').map(k => k.startsWith('0x') ? k : `0x${k}`)

program
  .option('-r, --rpc <url>', 'RPC endpoint URL (default localhost:8545), may be repeated', addRPC, [])
  .option('--header [<n>:]<k>:<v>', 'add a header to fetch requests (for nth rpc), may be repeated', addHeader, new Map())
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
  .requiredOption('-k, --signers <key(s)>', 'private key(s) of account to send transactions from, comma separated', getSigners)
program.parse()
const options = program.opts()

const urls = options.rpc.length ? options.rpc : ['http://localhost:8545']
const fetchRequests = urls.map((url) => new ethers.FetchRequest(url))
options.header.forEach((m, r) => {
  if (r === '*')
    fetchRequests.forEach(fr => m.forEach((v, k) => fr.setHeader(k, v)))
  else
    m.forEach((v, k) => fetchRequests[r].setHeader(k, v))
})
const providers = fetchRequests.map(fr => new ethers.JsonRpcProvider(fr))
const pollingInterval = parseInt(options.interval)
providers.forEach(pr => { pr.pollingInterval = pollingInterval })
console.log('Awaiting network...')
const networks = await Promise.all(providers.map(pr => pr.getNetwork()))
console.log(`Got ${networks.map(n => n.name)}`)
const network = networks[0]
const disconnectedSigners = options.signers.map(k => new ethers.Wallet(k))
console.log(`Signers: ${await Promise.all(disconnectedSigners.map(s => s.getAddress()))}`)
console.log(`Balance: ${await Promise.all(disconnectedSigners.map(s => providers[0].getBalance(s).then(b => ethers.formatEther(b))))}`)
let nonces = await Promise.all(disconnectedSigners.map(s => s.connect(providers[0]).getNonce()))
console.log(`Nonce: ${nonces}`)

function estimateGas(bytes) {
  return 21000 + 16 * bytes + 10000
}

const totalSlots = parseInt(options.slots)
const txPerSlot = parseInt(options.txns)
const total = txPerSlot * totalSlots
const delay = parseInt(options.delay)
const maxTxns = parseInt(options.maxTxns)
const sizeBytes = parseInt(options.size) * 1024 - parseInt(options.trimBytes)
const feeMult = BigInt(options.feeMult)
const gasMult = BigInt(options.gasMult)
const prioFee = ethers.parseUnits(options.priorityFee, 'gwei')
const gasLimit = estimateGas(sizeBytes)

function makeTxn(maxFee, nonce) {
  const tx = new ethers.Transaction()
  tx.chainId = network.chainId
  tx.maxFeePerGas = maxFee > prioFee ? maxFee : prioFee
  tx.maxPriorityFeePerGas = prioFee
  tx.nonce = nonce
  tx.gasLimit = gasLimit
  tx.to = options.contract
  tx.data = `0x${randomBytes(sizeBytes).toString('hex')}`
  return tx
}

const shortHash = (hash) => `${hash.substring(0, 4)}..${hash.substring(hash.length - 4)}`
const hashToNonce = new Map()

const submitted = []
let landed = 0

const startBlock = await providers[0].getBlockNumber()
const block = await providers[0].getBlock(startBlock)
console.log(`Block: ${startBlock}`)

let slot
let lastSeenBlockNumber = 0
let feeBlockNumber = lastSeenBlockNumber
let fastFee = block.baseFeePerGas * feeMult
let submittedLock = false

async function processSubmitted() {
  if (submittedLock) return
  submittedLock = true
  while (submitted.length && Promise.race([submitted[0], false])) {
    const receipt = await submitted.shift()
    console.log(`${hashToNonce.get(receipt.hash)} (${shortHash(receipt.hash)}) included in ${receipt.blockNumber}`)
    landed += 1
    if (receipt.blockNumber > lastSeenBlockNumber) {
      lastSeenBlockNumber = receipt.blockNumber
    }
  }
  submittedLock = false
}

let currentProvider = 0
let currentSigner = 0
let slotLock = false
let totalWantedTransactions = 0

const signedTransactions = []

async function makeTransactions() {
  for (const i of Array(total).keys()) {
    const provider = providers[currentProvider]
    const signer = disconnectedSigners[currentSigner].connect(provider)
    const tx = makeTxn(fastFee, nonces[currentSigner])
    const popTx = await signer.populateTransaction(tx)
    const signedTx = await signer.signTransaction(popTx)
    signedTransactions.push(signedTx)
    nonces[currentSigner] += 1
    currentProvider = (currentProvider + 1) % providers.length
    currentSigner = (currentSigner + 1) % disconnectedSigners.length
  }
}

await makeTransactions()
console.log(`Signed ${signedTransactions.length} transactions`)

async function processSlot() {
  while (slotLock) await new Promise(resolve => setTimeout(resolve, 750))
  slotLock = true
  totalWantedTransactions += txPerSlot
  console.log(`Processing slot ${slot}`)
  console.log(`Fast fee: ${ethers.formatUnits(fastFee, 'gwei')} gwei`)
  const waitingTransactions = submitted.length
  if (waitingTransactions + landed >= total) return
  let currentWantedTransactions = totalWantedTransactions - (landed + waitingTransactions)
  const toSubmit = Math.min(signedTransactions.length,
	  waitingTransactions + currentWantedTransactions >= maxTxns ? maxTxns - waitingTransactions : currentWantedTransactions)
  console.log(`Total: ${total}, landed: ${landed}, toSubmit: ${toSubmit}, submitted but not landed: ${waitingTransactions}`)
  const submittedAwaiting = []
  for (const i of Array(toSubmit).keys()) {
    const signedTx = signedTransactions.shift()
    const provider = providers[currentProvider]
    const responseAwaiting = provider.broadcastTransaction(signedTx)
    submittedAwaiting.push(responseAwaiting)
    currentProvider = (currentProvider + 1) % providers.length
  }
  await Promise.all(submittedAwaiting).then(responses => responses.forEach(response => {
    console.log(`Submitted ${response.nonce} as ${shortHash(response.hash)}`)
    hashToNonce.set(response.hash, response.nonce)
    submitted.push(response.wait())
  }))
  slotLock = false
}

//const GENESIS = 1606824023
const GENESIS = 1616508000 // Goerli

const now = Math.trunc(Date.now() / 1000)
let seconds = (now - GENESIS)
slot = Math.trunc(seconds / 12)

let intervalId

async function everySecond() {
  const now = Math.trunc(Date.now() / 1000)
  let seconds = (now - GENESIS)
  //console.log(`${Date.now()}: ${seconds} s`)
  if (seconds % 12 === 11) slot += 1
  //console.log(`Interval processing called at ${seconds}`)
  if (seconds % 12 === delay) {
    console.log(`Target delay hit at ${seconds}`)
    await processSlot()
  }
  await processSubmitted()
  if (feeBlockNumber < lastSeenBlockNumber) {
    feeBlockNumber = lastSeenBlockNumber
    const block = await providers[currentProvider].getBlock(feeBlockNumber)
    if (block) fastFee = block.baseFeePerGas * feeMult
  }
  if (!submitted.length && landed >= total)
    clearInterval(intervalId)
}

intervalId = setInterval(everySecond, 1000)
