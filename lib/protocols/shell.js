const os = require('os')
const Protomux = require('protomux')
const c = require('compact-encoding')
const PTY = require('tt-native')
const { PassThrough } = require('streamx')
const m = require('./messages.js')

const isWin = os.platform() === 'win32'
const shellFile = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash')
const EMPTY = Buffer.alloc(0)

class ShellServer {
  constructor (mux) {
    this.channel = mux.createChannel({
      protocol: 'hypershell',
      handshake: m.shell.spawn,
      onopen: this.onWireOpen.bind(this),
      onclose: this.onWireClose.bind(this),
      messages: [
        { encoding: c.buffer, onmessage: this.onWireStdin.bind(this) },
        { encoding: c.buffer }, // stdout
        { encoding: c.buffer }, // stderr
        { encoding: c.uint }, // exit code
        { encoding: m.shell.resize, onmessage: this.onWireResize.bind(this) }
      ]
    })

    this.wireStdout = this.channel.messages[1]
    this.wireStderr = this.channel.messages[2]
    this.wireExitCode = this.channel.messages[3]

    this.pty = null

    this.channel.open({})
  }

  static attach (mux) {
    return new this(mux)
  }

  onWireOpen (handshake) {
    try {
      this.pty = PTY.spawn(handshake.command || shellFile, handshake.args, {
        cwd: os.homedir(),
        env: process.env,
        width: handshake.width,
        height: handshake.height
      })
    } catch (err) {
      this.wireExitCode.send(1)
      this.wireStderr.send(Buffer.from(err.toString() + '\n'))
      this.channel.close()
      return
    }

    this.pty.on('data', (data) => this.wireStdout.send(data))
    this.pty.once('exit', (code) => this.wireExitCode.send(code))
    this.pty.once('close', () => this.channel.close())
  }

  onWireClose () {
    if (this.pty) {
      try {
        this.pty.kill('SIGKILL')
      } catch {} // ignore "Process has exited"
    }
  }

  onWireStdin (data, c) {
    if (data === null) this.pty.write(EMPTY)
    else this.pty.write(data)
  }

  onWireResize (data, c) {
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
      handshake: m.shell.spawn,
      onclose: this.onWireClose.bind(this),
      messages: [
        { encoding: c.buffer }, // stdin
        { encoding: c.buffer, onmessage: this.onWireStdout.bind(this) },
        { encoding: c.buffer, onmessage: this.onWireStderr.bind(this) },
        { encoding: c.uint, onmessage: this.onWireExitCode.bind(this) },
        { encoding: m.shell.resize }
      ]
    })

    this.wireStdin = this.channel.messages[0]
    this.wireResize = this.channel.messages[4]

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
    const opened = await this.channel.fullyOpened()

    if (!opened) {
      throw new Error('Could not connect to server')
    }
  }

  async close () {
    this.channel.close()

    await this.channel.fullyClosed()

    this.socket.destroy()
  }

  async fullyClosed () {
    await this.channel.fullyClosed()
  }

  onWireClose () {
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

    this.wireStdin.send(data)
  }

  onWireStdout (data, c) {
    this.stdout.write(data)
  }

  onWireStderr (data, c) {
    this.stderr.write(data)
  }

  onWireExitCode (code, c) {
    this.exitCode = code
  }

  onresize () {
    this.wireResize.send({
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
