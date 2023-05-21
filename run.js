import { ethers } from 'ethers'
import { program } from 'commander'
import { randomBytes } from 'node:crypto'

program
  .option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
  .option('-z, --size <kB>', 'calldata kilobytes to include per transaction', '64')
  .option('--trim-bytes <b>', 'trim a few bytes from the size', '256')
  .option('-b, --blocks <n>', 'number of blocks to run for', '10')
  .option('-t, --txns <n>', 'average number of transactions to aim to submit per block', '2')
  .option('-c, --contract <addr>', 'transaction recipient', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  .option('-f, --fee-mult <n>', 'base fee multiplier', '2')
  .option('-p, --priority-fee <gwei>', 'max priority fee per gas', '10')
  .option('-m, --max-txns <n>', 'maximum transactions to submit per block', '8')
  .requiredOption('-s, --signer <key>', 'private key of account to send transactions from')
program.parse()
const options = program.opts()

const provider = new ethers.JsonRpcProvider(options.rpc)
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
const prioFee = ethers.parseUnits(options.priorityFee, 'gwei')

function makeTxn(baseFee, nonce) {
  const tx = new ethers.Transaction()
  tx.chainId = network.chainId
  tx.maxFeePerGas = baseFee * feeMult
  tx.maxPriorityFeePerGas = prioFee
  tx.nonce = nonce
  tx.to = options.contract
  tx.data = `0x${randomBytes(sizeBytes).toString('hex')}`
  return tx
}

provider.on('block', async (blockNumber) => {
  console.log(`Got block ${blockNumber}`)
  const block = await provider.getBlock(blockNumber)
  const baseFee = block.baseFeePerGas
  console.log(`Base fee: ${ethers.formatUnits(baseFee, 'gwei')} gwei`)
  const tx = makeTxn(baseFee, 1)
  blocksLeft -= 1
  if (!txnsLeft || !blocksLeft) process.exit(0)
})
