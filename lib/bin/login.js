const fs = require('fs')
const path = require('path')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const Hypershell = require('../../index.js')
const KnownPeers = require('../known-peers.js')
const fileToKeyPair = require('../file-to-keypair.js')

module.exports = async function login (keyOrName, opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))

  if (!fs.existsSync(keyFilename)) {
    await keygen({ f: keyFilename })
  }

  const knownPeers = new KnownPeers({ cwd: constants.dir })
  const serverPublicKey = await knownPeers.getPublicKey(keyOrName)

  const hs = new Hypershell({
    bootstrap: opts.bootstrap
  })

  if (opts.invite === true) {
    const admin = hs.admin(serverPublicKey, {
      keyPair: await fileToKeyPair(keyFilename)
    })

    const invite = await admin.createInvite()

    console.log('One time invite:', z32.encode(invite))

    await admin.close()
    await hs.destroy()

    return
  }

  let keyPair = null

  if (typeof opts.invite === 'string') {
    const shortSeed = z32.decode(opts.invite)
    const seed = Buffer.alloc(32).fill(shortSeed, 0, shortSeed.length)

    keyPair = crypto.keyPair(seed)
  } else {
    keyPair = await fileToKeyPair(keyFilename)
  }

  const shell = hs.login(serverPublicKey, {
    keyPair,
    rawArgs: this.rawArgs,
    stdin: process.stdin,
    stdout: process.stdout,
    onerror: function (err) {
      process.exitCode = 1

      if (err.code === 'ECONNRESET') console.error('Connection closed.')
      else if (err.code === 'ETIMEDOUT') console.error('Connection timed out.')
      else if (err.code === 'PEER_NOT_FOUND') console.error(err.message)
      else if (err.code === 'PEER_CONNECTION_FAILED') console.error(err.message, '(probably firewalled)')
      else console.error(err)
    }
  })

  await shell.fullyClosed()

  if (shell.exitCode !== null) {
    process.exitCode = shell.exitCode
  }

  await hs.destroy()
}
