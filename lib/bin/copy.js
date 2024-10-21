const fs = require('fs')
const path = require('path')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const KnownPeers = require('../known-peers.js')
const fileToKeyPair = require('../file-to-keypair.js')
const Hypershell = require('../../index.js')

const publicKeyExpr = /^([a-fA-F0-9]{64}|[ybndrfg8ejkmcpqxot1uwisza345h769]{52}):/i

module.exports = async function copy (source, destination, opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))

  if (!fs.existsSync(keyFilename)) {
    await keygen({ f: keyFilename })
  }

  const direction = source[0] === '@' || publicKeyExpr.test(source) ? 'download' : 'upload'
  const keyOrName = parseRemotePath(direction === 'download' ? source : destination)[0]

  source = parseRemotePath(source)[1]
  destination = parseRemotePath(destination)[1]

  const knownPeers = new KnownPeers({ cwd: constants.dir })
  const serverPublicKey = await knownPeers.getPublicKey(keyOrName)

  const hs = new Hypershell({
    bootstrap: opts.bootstrap
  })

  const transfer = hs.copy(serverPublicKey, {
    keyPair: await fileToKeyPair(keyFilename)
  })

  try {
    if (direction === 'upload') {
      await transfer.upload(source, destination)
    } else {
      await transfer.download(source, destination)
    }
  } finally {
    await transfer.close()
    await hs.destroy()
  }
}

function parseRemotePath (str) {
  const i = str.indexOf(':')

  if (i === -1) {
    return [null, str]
  }

  const at = str[0] === '@' ? 1 : 0
  const host = str.slice(at, i)
  const path = str.slice(i + 1)

  return [host, path]
}
