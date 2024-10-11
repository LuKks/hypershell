const os = require('os')
const Protomux = require('protomux')
const c = require('compact-encoding')
const PTY = require('tt-native')
const { PassThrough } = require('streamx')
const m = require('./messages.js')
const waitForSocket = require('../wait-for-socket.js')

const isWin = os.platform() === 'win32'
const shellFile = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash')
const EMPTY = Buffer.alloc(0)

class ShellServer {
  constructor (mux) {
    this.channel = mux.createChannel({
      protocol: 'hypershell',
      id: null,
      handshake: m.handshakeSpawn,
      onopen: this.onopen.bind(this),
      onclose: this.onclose.bind(this),
      messages: [
        { encoding: c.buffer, onmessage: this.onstdin.bind(this) },
        { encoding: c.buffer }, // stdout
        { encoding: c.buffer }, // stderr
        { encoding: c.uint }, // exit code
        { encoding: m.resize, onmessage: this.onresize.bind(this) }
      ]
    })

    if (!this.channel) {
      throw new Error('Channel duplicated')
    }

    this.pty = null

    this.channel.open({})
  }

  static attach (mux) {
    return new this(mux)
  }

  onopen (handshake) {
    try {
      this.pty = PTY.spawn(handshake.command || shellFile, handshake.args, {
        cwd: os.homedir(),
        env: process.env,
        width: handshake.width,
        height: handshake.height
      })
    } catch (err) {
      this.channel.messages[3].send(1)
      this.channel.messages[2].send(Buffer.from(err.toString() + '\n'))
      this.channel.close()
      return
    }

    this.pty.on('data', (data) => this.channel.messages[1].send(data))
    this.pty.once('exit', (code) => this.channel.messages[3].send(code))
    this.pty.once('close', () => this.channel.close())
  }

  onclose () {
    if (this.pty) {
      try {
        this.pty.kill('SIGKILL')
      } catch {} // ignore "Process has exited"
    }
  }

  onstdin (data, c) {
    if (data === null) this.pty.write(EMPTY)
    else this.pty.write(data)
  }

  onresize (data, c) {
    this.pty.resize(data.width, data.height)
  }
}

class ShellClient {
  constructor (socket, opts = {}) {
    const spawn = parseVariadic(opts.rawArgs || [])

    this.command = spawn.shift() || ''
    this.args = spawn

    this.socket = socket
    this.mux = Protomux.from(socket)

    this.channel = this.mux.createChannel({
      protocol: 'hypershell',
      id: null,
      handshake: m.handshakeSpawn,
      onopen: this.onopen.bind(this),
      onclose: this.onclose.bind(this),
      messages: [
        { encoding: c.buffer }, // stdin
        { encoding: c.buffer, onmessage: this.onstdout.bind(this) },
        { encoding: c.buffer, onmessage: this.onstderr.bind(this) },
        { encoding: c.uint, onmessage: this.onexitcode.bind(this) },
        { encoding: m.resize }
      ]
    })

    if (!this.channel) {
      throw new Error('Channel duplicated')
    }

    this.stdin = opts.stdin || new PassThrough()
    this.stdout = opts.stdout || new PassThrough()
    this.exitCode = null

    this.onstdinBound = this.onstdin.bind(this)
    this.onresizeBound = this.onresize.bind(this)
    this.onsocketcloseBound = this.onsocketclose.bind(this)

    this.channel.open({
      command: this.command,
      args: this.args,
      width: this.stdout.columns || 80, // cols/rows doesn't exists if spawned without a terminal
      height: this.stdout.rows || 24
    })

    this._setup()
  }

  async ready () {
    await this.channel.fullyOpened()
  }

  async close () {
    this.socket.destroy()

    // TODO: Not needed anymore?
    await waitForSocket(this.socket)

    await this.channel.fullyClosed()
  }

  destroy () {
    this.socket.destroy()
  }

  onopen () {}

  onclose () {
    this.socket.destroy()
  }

  _setup () {
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true)
    }

    this.stdin.on('data', this.onstdinBound)
    this.stdout.on('resize', this.onresizeBound)
    this.socket.on('close', this.onsocketcloseBound)

    this.stdin.resume()
  }

  onstdin (data) {
    if (typeof data === 'string') {
      data = Buffer.from(data)
    }

    this.channel.messages[0].send(data)
  }

  onstdout (data, c) {
    this.stdout.write(data)
  }

  onstderr (data, c) {
    this.stderr.write(data)
  }

  onexitcode (code, c) {
    this.exitCode = code

    // TODO
    if (this.stdin === process.stdin) {
      process.exitCode = code
    }
  }

  onresize () {
    this.channel.messages[4].send({
      width: this.stdout.columns || 80,
      height: this.stdout.rows || 24
    })
  }

  onsocketclose () {
    if (this.stdin.isTTY) {
      this.stdin.setRawMode(false)
    }

    this.stdin.removeListener('data', this.onstdinBound)
    this.stdout.removeListener('resize', this.onresizeBound)
    this.socket.removeListener('close', this.onsocketcloseBound)

    this.stdin.pause()
  }
}

module.exports = {
  ShellServer,
  ShellClient,
  shellFile
}

function parseVariadic (rawArgs) {
  const index = rawArgs.indexOf('--')
  const variadic = index === -1 ? null : rawArgs.splice(index + 1)

  return variadic || []
}
