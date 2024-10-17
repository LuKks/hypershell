const fs = require('fs')
const path = require('path')
const net = require('net')
const test = require('brittle')
const tmp = require('like-tmp')
const crypto = require('hypercore-crypto')
const { getStreamError } = require('streamx')
const createTestnet = require('hyperdht/testnet')
const listen = require('listen-async')
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

test('shell - server is closed first', async function (t) {
  const hs = await createHypershell(t)

  const server = hs.createServer({ firewall: null })
  await server.listen()

  let exitCode = null
  const shell = hs.login(server.publicKey, { onerror })

  await shell.ready()
  await server.close()
  await shell.channel.fullyClosed()
  await hs.destroy()

  const err = getStreamError(shell.socket)

  t.is(err.code, 'ECONNRESET')
  t.is(exitCode, 1)

  function onerror () {
    exitCode = 1
  }
})

test('shell - exit code', async function (t) {
  const hs = await createHypershell(t)

  const server = hs.createServer({ firewall: null })
  await server.listen()

  const shell = hs.login(server.publicKey)
  await shell.ready()

  shell.stdin.write('exit 127\n')

  await shell.channel.fullyClosed()
  t.is(shell.exitCode, 127)

  await server.close()
  await hs.destroy()
})

test('basic copy', async function (t) {
  t.plan(6)

  const hs = await createHypershell(t)

  const server = hs.createServer({ firewall: null })
  await server.listen()

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

test('basic tunnel - local forwarding', async function (t) {
  t.plan(1)

  const t2 = t.test('tunnel')

  t2.plan(1)

  const hs = await createHypershell(t)

  const server = hs.createServer({ firewall: null })
  await server.listen()

  const tunnel = hs.tunnel(server.publicKey)

  const localPort = await freePort()
  const remotePort = await createTcpServer(t, socket => {
    socket.on('data', function (data) {
      socket.write('Hello World!')
    })
  })

  const proxy1 = await tunnel.local(localPort + ':127.0.0.1', remotePort + ':127.0.0.1')
  const socket = net.connect(localPort, '127.0.0.1')

  socket.on('data', function (data) {
    t2.alike(data, Buffer.from('Hello World!'))
  })

  socket.write('echo')

  await t2

  socket.end()

  await new Promise(resolve => socket.on('close', resolve))

  await proxy1.close()
  await tunnel.close()
  await server.close()
  await hs.destroy()
})

test('tunnel allowance', async function (t) {
  t.plan(1)

  const t2 = t.test('tunnel')

  t2.plan(1)

  const localPort = await freePort()
  const remotePort = await createTcpServer(t, socket => {
    t2.pass()
  })
  const blockedRemotePort = await createTcpServer(t, socket => {
    t2.fail()
  })

  const hs = await createHypershell(t)

  const server = hs.createServer({
    firewall: null,
    tunnel: {
      allow: ['127.0.0.1:' + remotePort]
    }
  })

  await server.listen()

  const tunnel = hs.tunnel(server.publicKey)

  const proxy = await tunnel.local(localPort + ':127.0.0.1', blockedRemotePort + ':127.0.0.1')

  // Fails to connect
  const socket = net.connect(localPort, '127.0.0.1')
  await new Promise(resolve => socket.on('close', resolve))

  // Change to the allowed remote port
  proxy.forwardTo(remotePort + ':127.0.0.1')

  // Able to connect
  const socket2 = net.connect(localPort, '127.0.0.1')
  await new Promise(resolve => socket2.on('connect', resolve))

  await t2

  socket2.end()
  await new Promise(resolve => socket2.on('close', resolve))

  await proxy.close()
  await tunnel.close()
  await server.close()
  await hs.destroy()
})

test('basic tunnel - remote forwarding', async function (t) {
  t.plan(1)

  const t2 = t.test('tunnel')

  t2.plan(1)

  const hs = await createHypershell(t)

  const server = hs.createServer({
    firewall: null,
    tunnel: {
      // allow: ['127.0.0.1:' + remotePort]
    }
  })

  await server.listen()

  const tunnel = hs.tunnel(server.publicKey)

  const localPort = await createTcpServer(t, socket => {
    socket.on('data', function (data) {
      socket.write('Hello World!')
    })
  })

  const remotePort = await freePort()

  const proxy = await tunnel.remote(remotePort + ':127.0.0.1', localPort + ':127.0.0.1')

  const socket = net.connect(remotePort, '127.0.0.1')

  socket.on('data', function (data) {
    t2.alike(data, Buffer.from('Hello World!'))
  })

  socket.write('echo')
  await t2

  socket.end()
  await new Promise(resolve => socket.on('close', resolve))

  await proxy.close()
  await tunnel.close()
  await server.close()
  await hs.destroy()
})

test('tunnels - failed to connect to server', async function (t) {
  t.plan(2)

  const hs = await createHypershell(t)

  const server = hs.createServer({ firewall: null })
  await server.listen()
  await server.close() // Server is closed!

  const tunnel = hs.tunnel(server.publicKey)

  try {
    await tunnel.local(await freePort(), await freePort())
    t.fail()
  } catch (err) {
    t.is(err.message, 'Could not connect to server')
  }

  try {
    await tunnel.remote(await freePort(), await freePort())
    t.fail()
  } catch (err) {
    t.is(err.message, 'Could not connect to server')
  }

  await tunnel.close()
  await server.close()
  await hs.destroy()
})

async function createHypershell (t) {
  const { bootstrap } = await createTestnet(3, t.teardown)

  return new Hypershell({ bootstrap })
}

async function createTcpServer (t, onrequest) {
  const server = net.createServer(onrequest)

  t.teardown(() => new Promise(resolve => server.close(resolve)))

  await listen(server, 0, '127.0.0.1')

  return server.address().port
}

function freePort () {
  return new Promise(resolve => {
    const server = net.createServer()

    server.listen(0, '127.0.0.1', function () {
      const addr = server.address()

      server.close(() => resolve(addr.port))
    })
  })
}
