const c = require('compact-encoding')

const stringArray = c.array(c.string)

const shell = exports.shell = {}

shell.spawn = {
  preencode (state, s) {
    c.string.preencode(state, s.command || '')
    stringArray.preencode(state, s.args || [])
    c.uint.preencode(state, s.width)
    c.uint.preencode(state, s.height)
  },
  encode (state, s) {
    c.string.encode(state, s.command || '')
    stringArray.encode(state, s.args || [])
    c.uint.encode(state, s.width)
    c.uint.encode(state, s.height)
  },
  decode (state) {
    return {
      command: c.string.decode(state),
      args: stringArray.decode(state),
      width: c.uint.decode(state),
      height: c.uint.decode(state)
    }
  }
}

shell.resize = {
  preencode (state, r) {
    c.uint.preencode(state, r.width)
    c.uint.preencode(state, r.height)
  },
  encode (state, r) {
    c.uint.encode(state, r.width)
    c.uint.encode(state, r.height)
  },
  decode (state) {
    return {
      width: c.uint.decode(state),
      height: c.uint.decode(state)
    }
  }
}

const copy = exports.copy = {}

copy.header = {
  preencode (state, h) {
    c.string.preencode(state, h.pack || '')
    c.string.preencode(state, h.extract || '')
    c.string.preencode(state, h.destination || '')
    c.bool.preencode(state, h.sourceIsDirectory || false)
  },
  encode (state, h) {
    c.string.encode(state, h.pack || '')
    c.string.encode(state, h.extract || '')
    c.string.encode(state, h.destination || '')
    c.bool.encode(state, h.sourceIsDirectory || false)
  },
  decode (state) {
    return {
      pack: c.string.decode(state),
      extract: c.string.decode(state),
      destination: c.string.decode(state),
      sourceIsDirectory: c.bool.decode(state)
    }
  }
}

copy.error = {
  preencode (state, e) {
    c.string.preencode(state, e.code || '')
    c.string.preencode(state, e.path || '')
    c.string.preencode(state, e.message || '')
  },
  encode (state, e) {
    c.string.encode(state, e.code || '')
    c.string.encode(state, e.path || '')
    c.string.encode(state, e.message || '')
  },
  decode (state) {
    return {
      code: c.string.decode(state),
      path: c.string.decode(state),
      message: c.string.decode(state)
    }
  }
}

const tunnel = exports.tunnel = {}

tunnel.message = {
  preencode (state, h) {
    c.string.preencode(state, h.id)
    c.string.preencode(state, h.message)
  },
  encode (state, h) {
    c.string.encode(state, h.id)
    c.string.encode(state, h.message)
  },
  decode (state) {
    return {
      id: c.string.decode(state),
      message: c.string.decode(state)
    }
  }
}

tunnel.serverStart = {
  preencode (state, h) {
    c.string.preencode(state, h.id)
    c.uint.preencode(state, h.port)
    c.string.preencode(state, h.host || '')
    c.uint.preencode(state, h.connect.port)
    c.string.preencode(state, h.connect.host || '')
  },
  encode (state, h) {
    c.string.encode(state, h.id)
    c.uint.encode(state, h.port)
    c.string.encode(state, h.host || '')
    c.uint.encode(state, h.connect.port)
    c.string.encode(state, h.connect.host || '')
  },
  decode (state) {
    return {
      id: c.string.decode(state),
      port: c.uint.decode(state),
      host: c.string.decode(state),
      connect: {
        port: c.uint.decode(state),
        host: c.string.decode(state)
      }
    }
  }
}

tunnel.serverClose = {
  preencode (state, h) {
    c.string.preencode(state, h.id)
  },
  encode (state, h) {
    c.string.encode(state, h.id)
  },
  decode (state) {
    return {
      id: c.string.decode(state)
    }
  }
}

tunnel.connect = {
  preencode (state, h) {
    c.string.preencode(state, h.serverId || '')
    c.uint.preencode(state, h.localStreamId)
    c.uint.preencode(state, h.connect.port)
    c.string.preencode(state, h.connect.host)
  },
  encode (state, h) {
    c.string.encode(state, h.serverId || '')
    c.uint.encode(state, h.localStreamId)
    c.uint.encode(state, h.connect.port)
    c.string.encode(state, h.connect.host)
  },
  decode (state) {
    return {
      serverId: c.string.decode(state),
      localStreamId: c.uint.decode(state),
      connect: {
        port: c.uint.decode(state),
        host: c.string.decode(state)
      }
    }
  }
}

tunnel.pump = {
  preencode (state, h) {
    c.uint.preencode(state, h.localStreamId)
    c.uint.preencode(state, h.remoteStreamId)
  },
  encode (state, h) {
    c.uint.encode(state, h.localStreamId)
    c.uint.encode(state, h.remoteStreamId)
  },
  decode (state) {
    return {
      localStreamId: c.uint.decode(state),
      remoteStreamId: c.uint.decode(state)
    }
  }
}
