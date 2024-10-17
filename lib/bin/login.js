const fs = require('fs')
const path = require('path')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const Hypershell = require('../../index.js')
const getKnownPeer = require('../get-known-peer.js')
const fileToKeyPair = require('../file-to-keypair.js')

module.exports = async function login (keyOrName, opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))

  if (!fs.existsSync(keyFilename)) {
    await keygen({ filename: keyFilename })
  }

  const serverPublicKey = await getKnownPeer(keyOrName, { verbose: true })

  const hs = new Hypershell({
    bootstrap: opts.bootstrap
  })

  const shell = hs.login(serverPublicKey, {
    keyPair: await fileToKeyPair(keyFilename),
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

  await shell.channel.fullyClosed()

  if (shell.exitCode !== null) {
    process.exitCode = shell.exitCode
  }

  await hs.destroy()
}
