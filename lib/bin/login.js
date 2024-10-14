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
    verbose: true,
    inherit: true
    /* onerror: function (err) {
      process.exitCode = 1
    } */
  })

  await shell.channel.fullyClosed()

  await hs.destroy()
}
