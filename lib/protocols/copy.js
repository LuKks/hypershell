const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('hypercore-crypto')
const tar = require('tar-fs')
const Protomux = require('protomux')
const c = require('compact-encoding')
const m = require('./messages.js')

const EMPTY = Buffer.alloc(0)

module.exports = class Copy {
  constructor (dht, publicKey, opts = {}) {
    this.dht = dht || null
    this.publicKey = publicKey || null

    this.keyPair = opts.keyPair || crypto.keyPair(opts.seed)

    this.mux = opts.mux || null
    this.channel = null

    this.wireHeader = null
    this.wireData = null
    this.wireError = null

    this.permissions = opts.permissions || []
    this.tar = null
    this.error = null

    this._onerror = opts.onerror || null
    this._dst = null

    if (!this.mux) {
      this._connect()
      this._createChannel()

      this.channel.open()
    }
  }

  static attach (opts = {}) {
    const copy = new this(null, null, opts)

    copy._createChannel()

    copy.channel.open()
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
    if (this.channel && this.mux.opened({ protocol: 'hypershell-copy' })) {
      return
    }

    this.channel = this.mux.createChannel({
      protocol: 'hypershell-copy',
      unique: false,
      onclose: this.onWireClose.bind(this),
      messages: [
        { encoding: m.copy.header, onmessage: this.onWireHeader.bind(this) },
        { encoding: c.raw, onmessage: this.onWireData.bind(this) },
        { encoding: m.copy.error, onmessage: this.onWireError.bind(this) }
      ]
    })

    this.wireHeader = this.channel.messages[0]
    this.wireData = this.channel.messages[1]
    this.wireError = this.channel.messages[2]
  }

  async upload (source, destination) {
    const copy = new Copy(this.dht, this.publicKey, {
      keyPair: this.keyPair,
      permissions: [],
      onerror: this._onerror
    })

    copy._pack(source, destination)

    await copy._done()
  }

  async download (source, destination) {
    const copy = new Copy(this.dht, this.publicKey, {
      keyPair: this.keyPair,
      permissions: ['extract'],
      onerror: this._onerror
    })

    // The server side should not know either control client's destination
    copy._dst = destination
    copy.wireHeader.send({ pack: source, destination: null })

    await copy._done()
  }

  async _done () {
    const opened = await this.channel.fullyOpened()

    if (!opened) {
      await this.close()

      if (this.error) throw makeError(this.error)
      else throw new Error('Could not connect to server')
    }

    await this.channel.fullyClosed()

    if (this.error) {
      throw makeError(this.error)
    }
  }

  async close () {
    if (this.mux) {
      this.mux.destroy()

      await this.channel.fullyClosed()
    }
  }

  onWireClose () {
    if (this.tar) this.tar.destroy()
  }

  onWireHeader (data, c) {
    const action = data.pack ? 'pack' : 'extract'

    if (!this.permissions.includes(action)) {
      this._exit(new Error('Action is not allowed: ' + action))
      return
    }

    if (data.pack) {
      this._pack(data.pack, data.destination)
    } else if (this._dst || data.extract) {
      this._extract(this._dst || data.extract, data.sourceIsDirectory)
    }
  }

  onWireData (data, c) {
    if (!this.tar) return

    if (data.length) this.tar.write(data)
    else this.tar.end()
  }

  onWireError (data, c) {
    if (this._onerror) this._onerror(data)

    this.error = data

    c.close()
  }

  _pack (source, destination) {
    source = path.resolve(resolveHomedir(source))

    try {
      const st = fs.lstatSync(source)
      const sourceIsDirectory = st.isDirectory()

      this.wireHeader.send({ extract: destination, sourceIsDirectory })
    } catch (err) {
      this._exit(err, source)
      return
    }

    this.tar = tar.pack(source)
    this.tar.on('data', chunk => this.wireData.send(chunk))
    this.tar.on('end', () => this.wireData.send(EMPTY))
    this.tar.on('error', err => this._exit(err))
  }

  _extract (destination, isDirectory) {
    destination = path.resolve(resolveHomedir(destination))

    const dir = isDirectory ? destination : path.dirname(destination)
    const options = {
      readable: true,
      writable: true,
      map: header => {
        if (!isDirectory) {
          header.name = path.basename(destination)
        }

        return header
      }
    }

    this.tar = tar.extract(dir, options)
    this.tar.on('finish', () => this.channel.close())
    this.tar.on('error', err => this._exit(err))
  }

  _exit (err, extra) {
    this.error = err

    if (this._onerror) this._onerror(err, extra)
    else this.wireError.send(err)

    this.channel.close()
  }
}

function resolveHomedir (str) {
  if (!str) return str
  if (str === '~') return os.homedir()
  if (str.slice(0, 2) !== '~/') return str
  return path.join(os.homedir(), str.slice(2))
}

function makeError (error) {
  const err = new Error(error.message)

  if (error.code) err.code = error.code
  if (error.path) err.path = error.path

  return err
}
