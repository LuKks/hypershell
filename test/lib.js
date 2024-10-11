const test = require('brittle')
const crypto = require('hypercore-crypto')
const { getStreamError } = require('streamx')
const createTestnet = require('hyperdht/testnet')
const Hypershell = require('../index.js')

test('basic shell', async function (t) {
  t.plan(2)

  const t2 = t.test('shell')

  t2.plan(1)

  const { bootstrap } = await createTestnet(3, t.teardown)
  const hs = new Hypershell({ bootstrap })

  const clientKeyPair = crypto.keyPair()

  const server = hs.createServer({ firewall: [clientKeyPair.publicKey] })
  await server.listen()

  const shell = hs.login(server.publicKey, { keyPair: clientKeyPair })

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

  await shell.close()
  await server.close()
  await hs.destroy()

  t.absent(getStreamError(shell.socket))
})

test('server is closed first', async function (t) {
  const hs = await createHypershell(t)
  const server = await createServer(hs)
  const shell = hs.login(server.publicKey)

  await shell.ready()

  await server.close()
  await shell.channel.fullyClosed()
  await hs.destroy()

  const err = getStreamError(shell.socket)

  t.is(err.code, 'ECONNRESET')
})

async function createHypershell (t) {
  const { bootstrap } = await createTestnet(3, t.teardown)

  return new Hypershell({ bootstrap })
}

async function createServer (hs, opts = {}) {
  const server = hs.createServer({ firewall: null, ...opts })

  await server.listen()

  return server
}
