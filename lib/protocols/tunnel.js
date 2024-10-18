const net = require('net')
const EventEmitter = require('events')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const pump = require('pump')
const DHT = require('hyperdht')
const Protomux = require('protomux')
const SecretStream = require('@hyperswarm/secret-stream')
const bind = require('like-bind')
const safetyCatch = require('safety-catch')
const m = require('./messages.js')

module.exports = class Tunnel {
  constructor (dht, publicKey, opts = {}) {
    this.dht = dht
    this.publicKey = publicKey

    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)
    this.allow = opts.allow || []

    this.mux = opts.mux || null
    this.channel = null

    this.wireCommand = null
    this.wireStream = null
    this.wirePump = null

    this._allow = new Map()
    this.streams = new Map()
    this.proxies = new Map()

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
    if (this.channel && this.mux.opened({ protocol: 'hypershell-tunnel' })) {
      return
    }

    this.channel = this.mux.createChannel({
      protocol: 'hypershell-tunnel',
      handshake: c.json,
      onclose: this.onWireClose.bind(this),
      messages: [
        { encoding: m.tunnel.message, onmessage: this.onWireMessage.bind(this) },
        { encoding: m.tunnel.serverStart, onmessage: this.onWireServerStart.bind(this) },
        { encoding: m.tunnel.serverClose, onmessage: this.onWireServerClose.bind(this) },
        { encoding: m.tunnel.connect, onmessage: this.onWireConnect.bind(this) },
        { encoding: m.tunnel.pump, onmessage: this.onWirePump.bind(this) }
      ]
    })

    this.wireMessage = this.channel.messages[0]
    this.wireServerStart = this.channel.messages[1]
    this.wireServerClose = this.channel.messages[2]
    this.wireConnect = this.channel.messages[3]
    this.wirePump = this.channel.messages[4]

    this.channel.open({})
  }

  static attach (dht, publicKey, opts = {}) {
    const tunnel = new this(dht, publicKey, opts)

    if (opts.allow) {
      tunnel.allow = opts.allow
    } else {
      // Allow the client to tell the server to connect to anything
      tunnel.allow = null
    }

    tunnel._createChannel()
  }

  async local (localAddress, remoteAddress, opts = {}) {
    let fwd = parseForwardFormat(localAddress + (remoteAddress ? ':' + remoteAddress : ''))

    // Early connect for faster initial connections also
    this._connect()
    this._createChannel()

    const opened = await this.channel.fullyOpened()

    if (!opened) {
      throw new Error('Could not connect to server')
    }

    const server = net.createServer(localSocket => {
      this._onLocalConnection(fwd, localSocket, opts.serverId)
    })

    await bind.listen(server, fwd.local.port, fwd.local.host)

    return {
      forwardTo: function (remoteAddress) {
        fwd = parseForwardFormat(localAddress + ':' + remoteAddress)
      },
      close: async function () {
        await bind.close(server, { force: true })
      }
    }
  }

  async remote (remoteAddress, localAddress) {
    const fwd = parseForwardFormat((localAddress ? localAddress + ':' : '') + remoteAddress)

    // TODO: Maybe pass two args to parseForwardFormat
    if (!localAddress) {
      const tmp = fwd.local

      fwd.local = fwd.remote
      fwd.remote = tmp
    }

    this._connect()
    this._createChannel()

    // Long secret id so the server can't guess the local allow
    const serverId = crypto.randomBytes(32).toString('hex')

    this._allow.set(serverId, [fwd.local.host + ':' + fwd.local.port])

    this.wireServerStart.send({
      id: serverId,
      port: fwd.remote.port,
      host: fwd.remote.host,
      connect: fwd.local
    })

    const ready = this._wait(serverId)
    const opened = await this.channel.fullyOpened()

    if (!opened) {
      // TODO: Check if onWireClose gets triggered if couldn't connect
      this._allow.delete(serverId)

      throw new Error('Could not connect to server')
    }

    await ready

    return {
      close: async () => {
        this._allow.delete(serverId)

        if (this.mux.stream.destroying || this.channel.closed) {
          return
        }

        this.wireServerClose.send({
          id: serverId
        })

        const closed = this._wait(serverId)

        await closed
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

  async onWireClose () {
    this._events.emit('close')

    for (const [, stream] of this.streams) {
      stream.destroy()
    }

    for (const [, proxy] of this.proxies) {
      await proxy.close().catch(safetyCatch)
    }

    this.streams.clear()
    this.proxies.clear()
  }

  _onLocalConnection (fwd, localSocket, serverId) {
    this._connect()
    this._createChannel()

    const rawStream = this._createRawStream()

    rawStream.userData = { localSocket }

    rawStream.on('close', () => localSocket.destroy())

    localSocket.on('error', safetyCatch)

    this.wireConnect.send({
      serverId,
      localStreamId: rawStream.id,
      connect: fwd.remote
    })
  }

  onWireMessage (data, c) {
    this._events.emit('message', data)
  }

  async onWireServerStart (data, c) {
    const { id, port, host, connect } = data

    const proxy = await this.local(port + ':' + host, connect.port + ':' + connect.host, { serverId: id })

    if (c.closed) {
      await proxy.close().catch(safetyCatch)
      return
    }

    this.proxies.set(id, proxy)

    this.wireMessage.send({ id, message: 'WIRE_SERVER_LISTENING' })
  }

  async onWireServerClose (data, c) {
    const { id } = data

    const proxy = this.proxies.get(id)

    if (proxy) {
      this.proxies.delete(id)

      await proxy.close().catch(safetyCatch)
    }

    this.wireMessage.send({ id, message: 'WIRE_SERVER_CLOSED' })
  }

  onWireConnect (data, c) {
    const { serverId, localStreamId, connect } = data

    const isLocallyAllowed = this._allow.has(serverId) && !firewallTunnel(this._allow.get(serverId), connect)
    const isGloballyAllowed = !firewallTunnel(this.allow, connect)

    if (!(isLocallyAllowed || isGloballyAllowed)) {
      c.close()
      return
    }

    const rawStream = this._createRawStream()
    const secretStream = this._connectRawStream(rawStream, localStreamId, true)
    const remoteSocket = net.connect(connect.port, connect.host)

    rawStream.userData = { secretStream, remoteSocket }

    pump(secretStream, remoteSocket, secretStream)

    this.wirePump.send({
      localStreamId,
      remoteStreamId: rawStream.id
    })
  }

  onWirePump (data, c) {
    const { localStreamId, remoteStreamId } = data

    const rawStream = this.streams.get(localStreamId)

    if (!rawStream) {
      throw new Error('Stream not found: ' + localStreamId)
    }

    const { localSocket } = rawStream.userData

    const secretStream = this._connectRawStream(rawStream, remoteStreamId, false)

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
