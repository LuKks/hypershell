const DHT = require('hyperdht')
const Protomux = require('protomux')
const HypercoreId = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const { ShellServer, ShellClient } = require('./lib/protocols/shell.js')
const Copy = require('./lib/protocols/copy.js')
const Tunnel = require('./lib/protocols/tunnel.js')

module.exports = class Hypershell {
  constructor (opts = {}) {
    this.dht = opts.dht || new DHT({ bootstrap: opts.bootstrap })

    this._autoDestroy = !opts.dht
  }

  createServer (opts = {}) {
    return new Server(this.dht, {
      ...opts,
      onsocket: function (socket) {
        const mux = Protomux.from(socket)

        if (this.protocols.includes('shell')) {
          mux.pair({ protocol: 'hypershell' }, () => {
            ShellServer.attach(mux)
          })
        }

        if (this.protocols.includes('copy')) {
          mux.pair({ protocol: 'hypershell-copy' }, () => {
            Copy.attach(mux, { permissions: ['pack', 'extract'] })
          })
        }

        if (this.protocols.includes('tunnel')) {
          mux.pair({ protocol: 'hypershell-tunnel' }, () => {
            const tunnel = new Tunnel(this.dht, null, {
              mux,
              allow: opts.tunnel?.allow
            })

            tunnel._createChannel()
          })
        }
      }
    })
  }

  login (publicKey, opts = {}) {
    const client = new Client(this.dht, publicKey, opts)

    return new ShellClient(client.socket, {
      rawArgs: opts.rawArgs,
      stdin: opts.stdin,
      stdout: opts.stdout
    })
  }

  copy (publicKey, opts = {}) {
    const client = new Client(this.dht, publicKey, opts)
    const mux = Protomux.from(client.socket)

    return { upload, download, close }

    async function upload (source, destination) {
      await Copy.upload(mux, source, destination)
    }

    async function download (source, destination) {
      await Copy.download(mux, source, destination)
    }

    async function close () {
      mux.destroy()
    }
  }

  tunnel (publicKey, opts = {}) {
    return new Tunnel(this.dht, publicKey, opts)
  }

  async destroy () {
    if (this._autoDestroy) {
      await this.dht.destroy()
    }
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

    socket.setKeepAlive(5000)

    socket.on('end', function () {
      socket.end()
    })

    socket.on('error', function (err) {
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        return
      }

      // TODO
      console.error(err.code, err)
    })

    socket.on('close', () => {
      this._connections.delete(socket)

      if (this.verbose) {
        console.log('Connection closed', HypercoreId.encode(socket.remotePublicKey))
      }
    })

    if (this.verbose) {
      console.log('Connection opened', HypercoreId.encode(socket.remotePublicKey))
    }

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

class Client {
  constructor (dht, publicKey, opts = {}) {
    this.dht = dht
    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)
    this.verbose = !!opts.verbose
    this.inherit = !!opts.inherit

    this.socket = this.dht.connect(publicKey, {
      keyPair: this.keyPair,
      reusableSocket: opts.reusableSocket
    })

    this._onerror = opts.onerror || null

    this._open()
  }

  _open () {
    this.socket.setKeepAlive(5000)

    this.socket.on('error', this._onSocketError.bind(this))
    this.socket.on('end', this._onSocketEnd.bind(this))
    this.socket.on('close', this._onSocketClose.bind(this))
  }

  _onSocketEnd () {
    this.socket.end()
  }

  _onSocketError (err) {
    if (this._onerror) {
      this._onerror(err)
    }

    if (this.inherit) {
      process.exitCode = 1
    }

    if (!this.verbose) {
      return
    }

    if (err.code === 'ECONNRESET') console.error('Connection closed.')
    else if (err.code === 'ETIMEDOUT') console.error('Connection timed out.')
    else if (err.code === 'PEER_NOT_FOUND') console.error(err.message)
    else if (err.code === 'PEER_CONNECTION_FAILED') console.error(err.message, '(probably firewalled)')
    else console.error(err)
  }

  _onSocketClose () {
    // TODO: Improve by removing listeners etc
    // this.close().catch(safetyCatch)
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
