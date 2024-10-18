const fs = require('fs')
const path = require('path')
const net = require('net')
const test = require('brittle')
const tmp = require('like-tmp')
const crypto = require('hypercore-crypto')
const { getStreamError } = require('streamx')
const createTestnet = require('hyperdht/testnet')
const bind = require('like-bind')
const Hypershell = require('../index.js')

test('basic shell', async function (t) {
  t.plan(2)

  const t2 = t.test('shell')

  t2.plan(1)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const shell = hs2.login(server.publicKey, { keyPair })

  let out = ''

  shell.stdout.on('data', function onstdout (data) {
    out += data.toString()

    if (out.includes('Hello World!')) {
      shell.stdout.removeListener('data', onstdout)

      t2.pass()
    }
  })

  shell.stdin.write('echo "Hello World!"\r\n')

  await t2

  await shell.close()
  await server.close()

  t.absent(getStreamError(shell.socket))
})

test('shell - server is closed first', async function (t) {
  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  let exitCode = null
  const shell = hs2.login(server.publicKey, { keyPair, onerror })

  await shell.ready()
  await server.close()
  await shell.fullyClosed()

  const err = getStreamError(shell.socket)

  t.is(err.code, 'ECONNRESET')
  t.is(exitCode, 1)

  function onerror () {
    exitCode = 1
  }
})

test('shell - exit code', async function (t) {
  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const shell = hs2.login(server.publicKey, { keyPair })
  await shell.ready()

  shell.stdin.write('exit 127\r\n')

  await shell.fullyClosed()
  t.is(shell.exitCode, 127)

  await server.close()
})

test('basic copy', async function (t) {
  t.plan(6)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const transfer = hs2.copy(server.publicKey, { keyPair })

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
})

test('basic tunnel - local forwarding', async function (t) {
  t.plan(1)

  const t2 = t.test('tunnel')

  t2.plan(1)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const tunnel = hs2.tunnel(server.publicKey, { keyPair })

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

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({
    firewall: [keyPair.publicKey],
    tunnel: {
      allow: ['127.0.0.1:' + remotePort]
    }
  })

  await server.listen()

  const tunnel = hs2.tunnel(server.publicKey, { keyPair })

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
})

test('basic tunnel - remote forwarding', async function (t) {
  t.plan(1)

  const t2 = t.test('tunnel')

  t2.plan(1)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const tunnel = hs2.tunnel(server.publicKey, { keyPair })

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
})

test('tunnels - failed to connect to server', async function (t) {
  t.plan(2)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()
  await server.close() // Server is closed!

  const tunnel = hs2.tunnel(server.publicKey, { keyPair })

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
})

test('tunnel - remote forwarding - retry on background', async function (t) {
  t.plan(2)

  const [hs1, hs2] = await createHypershells(t)
  const serverKeyPair = crypto.keyPair()
  const clientKeyPair = crypto.keyPair()

  const server = hs1.createServer({ keyPair: serverKeyPair, firewall: [clientKeyPair.publicKey] })
  await server.listen()

  const tunnel = hs2.tunnel(server.publicKey, { keyPair: clientKeyPair })

  const localPort = await createTcpServer(t, socket => {
    socket.on('data', function (data) {
      socket.write('Hello World!')
    })
  })

  const remotePort = await freePort()

  const proxy = await tunnel.remote(remotePort + ':127.0.0.1', localPort + ':127.0.0.1')

  t.alike(await recv(remotePort), Buffer.from('Hello World!'))

  // Server closed!
  await server.close()

  const server2 = hs1.createServer({ keyPair: serverKeyPair, firewall: [clientKeyPair.publicKey] })
  await server2.listen()

  await new Promise(resolve => setTimeout(resolve, 2000))

  t.alike(await recv(remotePort), Buffer.from('Hello World!'))

  await proxy.close()
  await tunnel.close()
  await server2.close()
})

test('chaos of tunnels', async function (t) {
  t.plan(20)

  const [hs1, hs2] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const tunnel = hs2.tunnel(server.publicKey, { keyPair })

  // Local tunnels
  const localPort1 = await freePort()
  const localPort2 = await freePort()
  const remotePort1 = await createTcpServer(t, function (socket) {
    socket.on('data', function (data) {
      socket.write('Hello World! A')
    })
  })
  const remotePort2 = await createTcpServer(t, function (socket) {
    socket.on('data', function (data) {
      socket.write('Hello World! B')
    })
  })

  const localProxy1 = await tunnel.local(localPort1 + ':127.0.0.1', remotePort1 + ':127.0.0.1')
  const localProxy2 = await tunnel.local(localPort2 + ':127.0.0.1:' + remotePort2 + ':127.0.0.1')

  // Remote tunnels
  const localPort3 = await createTcpServer(t, socket => {
    socket.on('data', function (data) {
      socket.write('Hello World! C')
    })
  })
  const localPort4 = await createTcpServer(t, socket => {
    socket.on('data', function (data) {
      socket.write('Hello World! D')
    })
  })
  const remotePort3 = await freePort()
  const remotePort4 = await freePort()

  const remoteProxy1 = await tunnel.remote(remotePort3 + ':127.0.0.1', localPort3 + ':127.0.0.1')
  const remoteProxy2 = await tunnel.remote(remotePort4 + ':127.0.0.1:' + localPort4 + ':127.0.0.1')

  // Connections
  t.alike(await recv(localPort1), Buffer.from('Hello World! A'))
  t.alike(await recv(localPort2), Buffer.from('Hello World! B'))
  t.alike(await recv(remotePort3), Buffer.from('Hello World! C'))
  t.alike(await recv(remotePort4), Buffer.from('Hello World! D'))

  await localProxy1.close()

  t.alike(await recv(localPort1), null)
  t.alike(await recv(localPort2), Buffer.from('Hello World! B'))
  t.alike(await recv(remotePort3), Buffer.from('Hello World! C'))
  t.alike(await recv(remotePort4), Buffer.from('Hello World! D'))

  await remoteProxy1.close()

  t.alike(await recv(localPort1), null)
  t.alike(await recv(localPort2), Buffer.from('Hello World! B'))
  t.alike(await recv(remotePort3), null)
  t.alike(await recv(remotePort4), Buffer.from('Hello World! D'))

  await localProxy2.close()

  t.alike(await recv(localPort1), null)
  t.alike(await recv(localPort2), null)
  t.alike(await recv(remotePort3), null)
  t.alike(await recv(remotePort4), Buffer.from('Hello World! D'))

  await remoteProxy2.close()

  t.alike(await recv(localPort1), null)
  t.alike(await recv(localPort2), null)
  t.alike(await recv(remotePort3), null)
  t.alike(await recv(remotePort4), null)

  await tunnel.close()
  await server.close()
})

test('invite', async function (t) {
  t.plan(1)

  const [hs1, hs2, hs3] = await createHypershells(t)
  const keyPair = crypto.keyPair()

  const server = hs1.createServer({ firewall: [keyPair.publicKey] })
  await server.listen()

  const admin = hs2.admin(server.publicKey, { keyPair })
  const invite = await admin.createInvite()
  await admin.close()

  const seed = Buffer.alloc(32).fill(invite, 0, invite.length)
  const keyPairInvite = crypto.keyPair(seed)

  const shell = hs3.login(server.publicKey, { keyPair: keyPairInvite })
  await shell.ready() // Logged in
  await shell.close()

  try {
    const shell = hs3.login(server.publicKey, { keyPair: keyPairInvite })
    await shell.ready()
    t.fail()
  } catch (err) {
    t.is(err.message, 'Could not connect to server')
  }

  await server.close()
})

async function recv (port, host) {
  const socket = net.connect(port, host || '127.0.0.1')

  socket.on('error', () => {})

  const connecting = new Promise(resolve => socket.once('connect', () => resolve(true)))
  const closing = new Promise(resolve => socket.once('close', () => resolve(false)))

  const opened = await Promise.race([connecting, closing])

  if (!opened) {
    return null
  }

  socket.write('echo')

  const message = await new Promise(resolve => socket.once('data', resolve))

  socket.end()

  await closing

  return message
}

async function createHypershells (t) {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const a = new Hypershell({ bootstrap })
  const b = new Hypershell({ bootstrap })
  const c = new Hypershell({ bootstrap })

  t.teardown(() => a.destroy())
  t.teardown(() => b.destroy())
  t.teardown(() => c.destroy())

  return [a, b, c]
}

async function createTcpServer (t, onrequest) {
  const server = net.createServer(onrequest)

  t.teardown(() => new Promise(resolve => server.close(resolve)))

  await bind.listen(server, 0, '127.0.0.1')

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
