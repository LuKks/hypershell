const net = require('net')
const EventEmitter = require('events')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const pump = require('pump')
const DHT = require('hyperdht')
const Protomux = require('protomux')
const SecretStream = require('@hyperswarm/secret-stream')
const bind = require('like-bind')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const m = require('./messages.js')

class LocalPortForwarding extends ReadyResource {
  constructor (tunnel, localAddress, remoteAddress, opts = {}) {
    super()

    this._tunnel = tunnel

    this._localAddress = localAddress
    this._fwd = parseForwardFormat(localAddress + (remoteAddress ? ':' + remoteAddress : ''))

    this._serverId = opts.serverId || null

    this._server = null

    this.ready().catch(safetyCatch)
  }

  async _open () {
    if (this._tunnel.closing) {
      throw new Error('Tunnel is closed')
    }

    // Early connect for faster initial connections also
    this._tunnel._connect()
    this._tunnel._createChannel()

    const opened = await this._tunnel.channel.fullyOpened()

    if (!opened) {
      throw new Error('Could not connect to server')
    }

    this._server = net.createServer(localSocket => {
      this._tunnel._onLocalConnection(this._fwd, localSocket, this._serverId)
    })

    await bind.listen(this._server, this._fwd.local.port, this._fwd.local.host)
  }

  async _close () {
    await bind.close(this._server, { force: true })
  }

  forwardTo (remoteAddress) {
    this._fwd = parseForwardFormat(this._localAddress + ':' + remoteAddress)
  }
}

class RemotePortForwarding extends ReadyResource {
  constructor (tunnel, remoteAddress, localAddress) {
    super()

    this._tunnel = tunnel

    const fwd = parseForwardFormat((localAddress ? localAddress + ':' : '') + remoteAddress)

    // TODO: Maybe pass two args to parseForwardFormat or inverse option
    if (!localAddress) {
      const tmp = fwd.local

      fwd.local = fwd.remote
      fwd.remote = tmp
    }

    this._fwd = fwd

    this._serverId = crypto.randomBytes(32).toString('hex')
    this._serverInfo = {
      id: this._serverId,
      port: fwd.remote.port,
      host: fwd.remote.host,
      connect: fwd.local
    }

    this._tunnel._allow.set(this._serverId, [fwd.local.host + ':' + fwd.local.port])

    this._signalClose = withResolvers()
    this._retryCount = 0
    this._onWireCloseBound = this._onWireClose.bind(this)

    this.ready().catch(safetyCatch)
  }

  async _open () {
    if (this._tunnel.closing) {
      throw new Error('Tunnel is closed')
    }

    this._tunnel._connect()
    this._tunnel._createChannel()

    this._tunnel.wireServerStart.send(this._serverInfo)

    const ready = this._tunnel._wait(this._serverId)
    const opened = await this._tunnel.channel.fullyOpened()

    if (!opened) {
      this._tunnel._allow.delete(this._serverId)

      throw new Error('Could not connect to server')
    }

    // Retry in case of disconnections
    this._tunnel._events.on('close', this._onWireCloseBound)

    await ready
  }

  async _close () {
    this._tunnel._events.off('close', this._onWireCloseBound)

    this._tunnel._allow.delete(this._serverId)

    this._signalClose.resolve()

    if (this._tunnel.mux.stream.destroying || this._tunnel.channel.closed) {
      return
    }

    this._tunnel.wireServerClose.send({
      id: this._serverId
    })

    const serverClosed = this._tunnel._wait(this._serverId)

    await serverClosed
  }

  async _onWireClose () {
    const wait = withResolvers()
    const time = 500 * Math.min(this._retryCount++, 5)
    const timeout = setTimeout(() => wait.resolve(), time)

    await Promise.race([wait.promise, this._signalClose.promise])

    if (this.closing || this._tunnel.closing) {
      clearTimeout(timeout)
      return
    }

    this._tunnel._connect()
    this._tunnel._createChannel()

    this._tunnel.wireServerStart.send(this._serverInfo)
  }
}

module.exports = class Tunnel extends ReadyResource {
  constructor (dht, publicKey, opts = {}) {
    super()

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

  local (localAddress, remoteAddress, opts = {}) {
    return new LocalPortForwarding(this, localAddress, remoteAddress, opts)
  }

  remote (remoteAddress, localAddress) {
    return new RemotePortForwarding(this, remoteAddress, localAddress)
  }

  async _open () {
    this._connect()
    this._createChannel()

    const opened = await this.channel.fullyOpened()

    if (!opened) {
      throw new Error('Could not connect to server')
    }
  }

  async _close () {
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

    this.streams.clear()

    for (const [id, proxy] of this.proxies) {
      this.proxies.delete(id)

      await proxy.close().catch(safetyCatch)
    }
  }

  _onLocalConnection (fwd, localSocket, serverId) {
    if (this.closing) {
      localSocket.destroy()
      return
    }

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

    const proxy = this.local(host + ':' + port, connect.host + ':' + connect.port, { serverId: id })

    await proxy.ready()

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
  const local = { host: null, port: null }
  const remote = { host: null, port: null }

  for (const part of value.split(':')) {
    const isHost = isNaN(part)

    if (isHost) {
      if (!local.port) local.host = part
      else if (!remote.port) remote.host = part
      else throw new Error('Invalid host format')
    } else {
      if (!local.port) local.port = parseInt(part, 10)
      else if (!remote.port) remote.port = parseInt(part, 10)
      else throw new Error('Invalid port format')
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

function withResolvers () {
  let resolve = null
  let reject = null

  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  return { promise, resolve, reject }
}
