const fs = require('fs')
const path = require('path')
const test = require('brittle')
const tmp = require('like-tmp')
const HypercoreId = require('hypercore-id-encoding')
const createTestnet = require('hyperdht/testnet')
const fileToKeyPair = require('../lib/file-to-keypair.js')
const { hypershell, hypershellSpawn, closeProcess, waitForLog } = require('./helpers/index.js')

test('basic', async function (t) {
  t.plan(1)

  const t2 = t.test('shell')

  t2.plan(1)

  const dir = await tmp(t)
  const testnet = await createTestnet(3, t.teardown)
  const bootstrap = testnet.bootstrap[0].host + ':' + testnet.bootstrap[0].port

  hypershell('keygen', ['-f', path.join(dir, 'server-key')])
  hypershell('keygen', ['-f', path.join(dir, 'client-key')])

  const serverKeyPair = await fileToKeyPair(path.join(dir, 'server-key'))
  const clientKeyPair = await fileToKeyPair(path.join(dir, 'client-key'))

  const server = await hypershellSpawn(t, 'server', [
    '--bootstrap', bootstrap,
    '-f', path.join(dir, 'server-key'),
    '--firewall', path.join(dir, 'firewall')
  ])

  await waitForLog(server, 'To connect to this shell')

  await fs.promises.writeFile(path.join(dir, 'firewall'), HypercoreId.encode(clientKeyPair.publicKey) + '\n')

  const shell = await hypershellSpawn(t, 'login', [
    HypercoreId.encode(serverKeyPair.publicKey),
    '--bootstrap', bootstrap,
    '-f', path.join(dir, 'client-key')
  ])

  let out = ''

  shell.stdout.on('data', function onstdout (data) {
    out += data.toString()

    if (out.includes('Hello World!')) {
      shell.stdout.removeListener('data', onstdout)

      t2.pass()
    }
  })

  shell.stdin.write('echo "Hello World!"\n')

  await t2

  await closeProcess(shell)
  await closeProcess(server)
})
