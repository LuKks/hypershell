const fs = require('fs')
const keygen = require('./keygen.js')
const Hypershell = require('../../index.js')
const getKnownPeer = require('../get-known-peer.js')
const fileToKeyPair = require('../file-to-keypair.js')

module.exports = async function login (serverPublicKey, opts = {}) {
  console.log('login', opts)

  if (!fs.existsSync(opts.f)) {
    await keygen({ filename: opts.f })
  }

  const target = await getKnownPeer(serverPublicKey, { verbose: true })

  const hs = new Hypershell({
    bootstrap: opts.bootstrap
  })

  const shell = hs.login(target, {
    keyPair: await fileToKeyPair(opts.f),
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
