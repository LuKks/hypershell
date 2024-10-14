const fs = require('fs')
const os = require('os')
const path = require('path')
const tar = require('tar-fs')
const c = require('compact-encoding')
const m = require('./messages.js')

const EMPTY = Buffer.alloc(0)

module.exports = class Copy {
  constructor (mux, opts = {}) {
    this.channel = mux.createChannel({
      protocol: 'hypershell-copy',
      unique: false,
      // handshake: m.handshakeCopy,
      onopen: this.onopen.bind(this),
      onclose: this.onclose.bind(this),
      messages: [
        { encoding: m.copyHeader, onmessage: this.onWireHeader.bind(this) },
        { encoding: c.raw, onmessage: this.onWireData.bind(this) },
        { encoding: m.error, onmessage: this.onWireError.bind(this) }
      ]
    })

    this.wireHeader = this.channel.messages[0]
    this.wireData = this.channel.messages[1]
    this.wireError = this.channel.messages[2]

    this.permissions = opts.permissions || []
    this.tar = null
    this.error = null

    this._onerror = opts.onerror || null
    this._dst = null
  }

  static attach (mux, opts) {
    const copy = new this(mux, opts)

    copy.channel.open()
  }

  static async upload (mux, source, destination) {
    const copy = new this(mux)

    copy.upload(source, destination)

    await copy.channel.fullyClosed()

    if (copy.error) {
      throw makeError(copy.error)
    }
  }

  static async download (mux, source, destination) {
    const copy = new this(mux, { permissions: ['extract'] })

    copy.download(source, destination)

    await copy.channel.fullyClosed()

    if (copy.error) {
      throw makeError(copy.error)
    }
  }

  upload (source, destination) {
    this.channel.open()

    this._pack(source, destination)
  }

  download (source, destination) {
    this.channel.open()

    // The server side should not know either control client's destination
    this._dst = destination
    this.wireHeader.send({ pack: source, destination: null })
  }

  onopen (h) {}

  onclose () {
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
