const net = require('net')
const EventEmitter = require('events')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const pump = require('pump')
const DHT = require('hyperdht')
const Protomux = require('protomux')
const SecretStream = require('@hyperswarm/secret-stream')
const listen = require('listen-async')
const safetyCatch = require('safety-catch')
const nextId = require('../next-id')

module.exports = class Tunnel {
  constructor (dht, publicKey, opts = {}) {
    this.dht = dht
    this.publicKey = publicKey

    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)
    this.allow = opts.allow || null

    this.mux = opts.mux || null
    this.channel = null

    this.wireCommand = null
    this.wireStream = null
    this.wirePump = null

    this.streams = new Map()
    this.proxies = new Set()

    this.nextId = nextId()

    this._events = new EventEmitter()
  }

  _connect () {
    if (this.mux && !this.mux.stream.destroying) {
      return
    }

    const socket = this.dht.connect(this.publicKey, {
      keyPair: this.keyPair,
      reusableSocket: true
    })

    socket.setKeepAlive(5000)

    this.mux = Protomux.from(socket)
  }

  _createChannel () {
    if (this.mux.opened({ protocol: 'hypershell-tunnel' })) {
      return
    }

    const channel = this.mux.createChannel({
      protocol: 'hypershell-tunnel',
      handshake: c.json,
      onopen: this.onopen.bind(this),
      onclose: this.onclose.bind(this),
      messages: [
        { encoding: c.json, onmessage: this.onMessage.bind(this) },
        { encoding: c.json, onmessage: this.onWireServer.bind(this) },
        { encoding: c.json, onmessage: this.onWireConnect.bind(this) },
        { encoding: c.json, onmessage: this.onWirePump.bind(this) }
      ]
    })

    if (channel === null) {
      return
    }

    this.channel = channel

    this.wireMessage = this.channel.messages[0]
    this.wireServer = this.channel.messages[1]
    this.wireConnect = this.channel.messages[2]
    this.wirePump = this.channel.messages[3]

    this.channel.open({})
  }

  static attach (dht, publicKey, opts = {}) {
    const tunnel = new this(dht, publicKey, opts)

    tunnel._createChannel()
  }

  async local (localAddress, remoteAddress) {
    let fwd = parseForwardFormat(localAddress + (remoteAddress ? ':' + remoteAddress : ''))

    // TODO: This is to get a new isolated channel easly for now
    const instance = new Tunnel(this.dht, this.publicKey, {
      keyPair: this.keyPair
    })

    // Early connect for faster initial connections, and the opened check
    instance._connect()
    instance._createChannel()

    const opened = await instance.channel.fullyOpened()

    if (!opened) {
      await instance.close()

      throw new Error('Could not connect to server')
    }

    const server = net.createServer(localSocket => {
      instance._onLocalConnection(fwd, localSocket)
    })

    await listen(server, fwd.local.port, fwd.local.host)

    return {
      forwardTo: function (remoteAddress) {
        fwd = parseForwardFormat(localAddress + ':' + remoteAddress)
      },
      close: async function () {
        // TODO: Force close connections
        await new Promise(resolve => server.close(resolve))

        await instance.close()
      }
    }
  }

  async remote (remoteAddress, localAddress) {
    const fwd = parseForwardFormat((localAddress ? localAddress + ':' : '') + remoteAddress)

    // TODO: This is to get a new isolated channel easly for now
    // So that if connection is lost then the other side can drop its resources
    // Client can handle reconnection e.g. re-execute remote()
    const instance = new Tunnel(this.dht, this.publicKey, {
      keyPair: this.keyPair,
      allow: [fwd.local.host + ':' + fwd.local.port]
    })

    instance._connect()
    instance._createChannel()

    const serverId = instance.nextId()

    // Only one remote server per channel
    instance.wireServer.send({
      id: serverId,
      port: fwd.remote.port,
      host: fwd.remote.host,
      connect: fwd.local
    })

    const ready = instance._wait(serverId)
    const opened = await instance.channel.fullyOpened()

    if (!opened) {
      await instance.close()

      throw new Error('Could not connect to server')
    }

    await ready

    return {
      close: async function () {
        await instance.close()
      }
    }
  }

  async close () {
    if (this.mux) {
      this.mux.destroy()

      await this.channel.fullyClosed()
    }
  }

  _wait (id) {
    if (!this.channel || this.channel.closed) {
      return Promise.reject(new Error('Channel already closed'))
    }

    const p = waitForMessage(this._events, id)

    p.catch(safetyCatch)

    return p
  }

  onopen (h) {}

  async onclose () {
    this._events.emit('close')

    for (const [, stream] of this.streams) {
      stream.destroy()
    }

    for (const proxy of this.proxies) {
      await proxy.close().catch(safetyCatch)
    }

    this.streams.clear()
    this.proxies.clear()
  }

  _onLocalConnection (fwd, localSocket) {
    this._connect()
    this._createChannel()

    const rawStream = this._createRawStream()

    rawStream.userData = { localSocket }

    rawStream.on('close', () => localSocket.destroy())

    localSocket.on('error', safetyCatch)

    this.wireConnect.send({
      clientId: rawStream.id,
      connect: fwd.remote
    })
  }

  onMessage (data, c) {
    this._events.emit('message', data)
  }

  async onWireServer (data, c) {
    const { id, port, host, connect } = data

    const proxy = await this.local(port + ':' + host, connect.port + ':' + connect.host)

    if (c.closed) {
      await proxy.close().catch(safetyCatch)
      return
    }

    this.proxies.add(proxy)

    this.wireMessage.send({ id, message: 'WIRE_SERVER_READY' })
  }

  onWireConnect (data, c) {
    const { clientId, connect } = data

    if (firewallTunnel(this.allow, connect)) {
      c.close()
      return
    }

    const rawStream = this._createRawStream()
    const secretStream = this._connectRawStream(rawStream, clientId, true)
    const remoteSocket = net.connect(connect.port, connect.host)

    rawStream.userData = { secretStream, remoteSocket }

    pump(secretStream, remoteSocket, secretStream)

    this.wirePump.send({
      clientId,
      serverId: rawStream.id
    })
  }

  onWirePump (data, c) {
    const { clientId, serverId } = data

    const rawStream = this.streams.get(clientId)

    if (!rawStream) {
      throw new Error('Stream not found: ' + clientId)
    }

    const { localSocket } = rawStream.userData

    const secretStream = this._connectRawStream(rawStream, serverId, false)

    rawStream.userData.secretStream = secretStream

    pump(localSocket, secretStream, localSocket)
  }

  _createRawStream () {
    const rawStream = this.dht.createRawStream()

    rawStream.on('close', () => this.streams.delete(rawStream.id))
    rawStream.on('error', safetyCatch)

    this.streams.set(rawStream.id, rawStream)

    return rawStream
  }

  _connectRawStream (rawStream, id, isInitiator) {
    DHT.connectRawStream(this.mux.stream, rawStream, id)

    const secretStream = new SecretStream(isInitiator, rawStream)

    secretStream.on('error', safetyCatch)

    secretStream.setKeepAlive(5000)

    return secretStream
  }
}

function parseForwardFormat (value) {
  const local = { port: null, host: null }
  const remote = { port: null, host: null }

  for (const part of value.split(':')) {
    const isNumber = !isNaN(part)

    if (isNumber) {
      if (!local.port) local.port = parseInt(part, 10)
      else if (!remote.port) remote.port = parseInt(part, 10)
      else throw new Error('Invalid port format')
    } else {
      if (remote.port) remote.host = part
      else if (local.port) local.host = part
      else throw new Error('Invalid address format')
    }
  }

  return { local, remote }
}

function firewallTunnel (addresses, target) {
  if (!addresses) {
    return false
  }

  for (const address of addresses) {
    const [host, port] = address.split(':')

    if (target.host !== host) {
      continue
    }

    if (port) {
      const ports = port.split('-')

      if (ports.length === 1) {
        if (target.port !== parseInt(port, 10)) {
          continue
        }
      } else {
        const from = parseInt(ports[0], 10)
        const to = parseInt(ports[1], 10)

        if (target.port < from || target.port > to) {
          continue
        }
      }
    }

    return false
  }

  return true
}

function waitForMessage (events, id) {
  let waitResolve = null
  let waitReject = null

  const promise = new Promise((resolve, reject) => {
    waitResolve = resolve
    waitReject = reject
  })

  const timeout = setTimeout(() => {
    unlisten()
    waitReject(new Error('Timed out while waiting for confirmation'))
  }, 15000)

  events.on('message', onmessage)
  events.on('close', onclose)

  return promise

  function onmessage (data) {
    if (data.id === id) {
      clearTimeout(timeout)
      unlisten()
      waitResolve(data)
    }
  }

  function onclose () {
    clearTimeout(timeout)
    unlisten()
    waitReject(new Error('Connection closed while waiting for confirmation'))
  }

  function unlisten () {
    events.off('message', onmessage)
    events.off('close', onclose)
  }
}
