const DHT = require('hyperdht')
const Protomux = require('protomux')
const HypercoreId = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const safetyCatch = require('safety-catch')
const { ShellServer, ShellClient } = require('./lib/protocols/shell.js')
const Copy = require('./lib/protocols/copy.js')
const Tunnel = require('./lib/protocols/tunnel.js')

module.exports = class Hypershell {
  constructor (opts = {}) {
    this.dht = opts.dht || new DHT({ bootstrap: opts.bootstrap })

    this._autoDestroy = !opts.dht
  }

  createServer (opts = {}) {
    return new Server(this.dht, { ...opts, onsocket })

    function onsocket (socket) {
      const mux = Protomux.from(socket)

      if (this.protocols.includes('shell')) {
        mux.pair({ protocol: 'hypershell' }, () => {
          ShellServer.attach(mux)
        })
      }

      if (this.protocols.includes('copy')) {
        mux.pair({ protocol: 'hypershell-copy' }, () => {
          Copy.attach({ mux, permissions: ['pack', 'extract'] })
        })
      }

      if (this.protocols.includes('tunnel')) {
        mux.pair({ protocol: 'hypershell-tunnel' }, () => {
          Tunnel.attach(this.dht, socket.publicKey, {
            mux,
            allow: opts.tunnel?.allow
          })
        })
      }
    }
  }

  login (publicKey, opts = {}) {
    const socket = this.dht.connect(publicKey, {
      keyPair: opts.keyPair || crypto.keyPair(opts.seed),
      reusableSocket: true
    })

    socket.setKeepAlive(5000)

    socket.on('error', onerror)

    return new ShellClient(socket, {
      rawArgs: opts.rawArgs,
      stdin: opts.stdin,
      stdout: opts.stdout
    })

    function onerror (err) {
      if (opts.onerror) {
        opts.onerror(err)
      }
    }
  }

  copy (publicKey, opts = {}) {
    return new Copy(this.dht, publicKey, opts)
  }

  tunnel (publicKey, opts = {}) {
    return new Tunnel(this.dht, publicKey, opts)
  }

  async destroy () {
    if (this._autoDestroy) {
      await this.dht.destroy()
    }
  }

  static keyPair (seed) {
    return crypto.keyPair(seed)
  }
}

class Server {
  constructor (dht, opts = {}) {
    this.dht = dht
    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)
    this.firewall = opts.firewall || opts.firewall === null ? opts.firewall : []
    this.verbose = !!opts.verbose
    this.protocols = opts.protocols || ['shell', 'copy', 'tunnel']

    this._server = this.dht.createServer({
      firewall: this._onFirewall.bind(this)
    })

    this._server.on('connection', this._onConnection.bind(this))

    this._connections = new Set()
    this._onsocket = opts.onsocket || null
  }

  async listen (keyPair) {
    await this._server.listen(keyPair || this.keyPair)
  }

  async close () {
    await this._server.close() // TODO: Force option?

    await closeConnections(this._connections, true)
  }

  get publicKey () {
    return this.keyPair.publicKey
  }

  _onConnection (socket) {
    this._connections.add(socket)

    if (this.verbose) {
      console.log('Connection opened', HypercoreId.encode(socket.remotePublicKey))
    }

    socket.setKeepAlive(5000)

    socket.on('error', safetyCatch)

    socket.on('close', () => {
      this._connections.delete(socket)

      if (this.verbose) {
        console.log('Connection closed', HypercoreId.encode(socket.remotePublicKey))
      }
    })

    if (this._onsocket) {
      this._onsocket(socket)
    }
  }

  _onFirewall (remotePublicKey, remoteHandshakePayload) {
    if (this.firewall === null) {
      return false
    }

    for (const publicKey of this.firewall) {
      if (remotePublicKey.equals(publicKey)) {
        return false
      }
    }

    if (this.verbose) {
      console.log('Firewall denied', HypercoreId.encode(remotePublicKey))
    }

    return true
  }
}

function closeConnections (sockets, force) {
  return new Promise(resolve => {
    if (sockets.size === 0) {
      resolve()
      return
    }

    let waiting = 0

    for (const socket of sockets) {
      waiting++

      socket.on('close', onclose)

      if (force) socket.destroy()
      else socket.end()
    }

    function onclose () {
      if (--waiting === 0) {
        resolve()
      }
    }
  })
}
