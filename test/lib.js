const fs = require('fs')
const path = require('path')
const test = require('brittle')
const tmp = require('like-tmp')
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

test.skip('basic tunnel', async function (t) {
  t.plan(2)

  const hs = await createHypershell(t)
  const server = await createServer(hs)
  const tunnel = hs.tunnel(server.publicKey)

  await tunnel.local('127.0.0.1:8080', '127.0.0.1:80')

  await tunnel.close()
  await server.close()
  await hs.destroy()
})

test('basic copy', async function (t) {
  t.plan(6)

  const hs = await createHypershell(t)
  const server = await createServer(hs)
  const transfer = hs.copy(server.publicKey)

  const dir = await tmp(t)
  const msg = Buffer.from('Hello World!')

  await fs.promises.writeFile(path.join(dir, 'file.txt'), msg)

  await transfer.upload(path.join(dir, 'file.txt'), path.join(dir, 'uploaded.txt'))
  t.alike(await fs.promises.readFile(path.join(dir, 'uploaded.txt')), msg)

  await transfer.download(path.join(dir, 'uploaded.txt'), path.join(dir, 'downloaded.txt'))
  t.alike(await fs.promises.readFile(path.join(dir, 'downloaded.txt')), msg)

  try {
    await transfer.upload(path.join(dir, 'not-exists.txt'), path.join(dir, 'uploaded.txt'))
    t.fail()
  } catch (err) {
    t.is(err.code, 'ENOENT')
    t.ok(err.path)
  }

  try {
    await transfer.download(path.join(dir, 'not-exists.txt'), path.join(dir, 'downloaded.txt'))
    t.fail()
  } catch (err) {
    t.is(err.code, 'ENOENT')
    t.ok(err.path)
  }

  await transfer.close()
  await server.close()
  await hs.destroy()
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
