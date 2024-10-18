const crypto = require('hypercore-crypto')
const ProtomuxRPC = require('protomux-rpc')
const m = require('./messages.js')

class AdminServer {
  constructor (socket, server) {
    this.server = server

    this.rpc = new ProtomuxRPC(socket, {
      protocol: 'hypershell-admin'
    })

    this.rpc.respond('invite', m.admin.invite, this.onWireInvite.bind(this))
  }

  static attach (socket, server) {
    return new this(socket, server)
  }

  onWireInvite (req, b) {
    this.server._cleanupInvites()

    const shortSeed = crypto.randomBytes(8)
    const seed = Buffer.alloc(32).fill(shortSeed, 0, shortSeed.length)
    const keyPair = crypto.keyPair(seed)

    const expiration = Date.now() + (req.expiry || 60 * 60 * 1000)

    this.server.invites.set(keyPair.publicKey.toString('hex'), expiration)

    return shortSeed
  }
}

class AdminClient {
  constructor (dht, publicKey, opts = {}) {
    this.dht = dht
    this.publicKey = publicKey

    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)

    this.rpc = null
  }

  _connect () {
    if (this.rpc && !this.rpc.stream.destroying) {
      return
    }

    const socket = this.dht.connect(this.publicKey, {
      keyPair: this.keyPair,
      reusableSocket: true
    })

    socket.setKeepAlive(5000)

    this.rpc = new ProtomuxRPC(socket, {
      protocol: 'hypershell-admin'
    })
  }

  static attach (mux) {
    return new this(mux)
  }

  async ready () {
    this._connect()

    // TODO
    const opened = await this.rpc._channel.fullyOpened()

    if (!opened) {
      throw new Error('Could not connect to server')
    }
  }

  async close () {
    this.rpc.destroy()

    await this.rpc._channel.fullyClosed()

    this.rpc.stream.destroy()
  }

  async createInvite (opts = {}) {
    await this.ready()

    const shortSeed = await this.rpc.request('invite', {
      expiry: opts.expiry || 0
    }, m.admin.invite)

    return shortSeed
  }
}

module.exports = {
  AdminServer,
  AdminClient
}
