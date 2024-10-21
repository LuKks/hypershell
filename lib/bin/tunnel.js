const fs = require('fs')
const path = require('path')
const goodbye = require('graceful-goodbye')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const KnownPeers = require('../known-peers.js')
const fileToKeyPair = require('../file-to-keypair.js')
const Hypershell = require('../../index.js')

module.exports = async function tunnel (keyOrName, opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))

  if (!fs.existsSync(keyFilename)) {
    await keygen({ f: keyFilename })
  }

  if (!opts.L && !opts.R) {
    throw new Error('-L o -R is required')
  }

  const knownPeers = new KnownPeers()
  const serverPublicKey = await knownPeers.getPublicKey(keyOrName)

  const hs = new Hypershell({ bootstrap: opts.bootstrap })

  const tunnel = hs.tunnel(serverPublicKey, {
    keyPair: await fileToKeyPair(keyFilename)
  })

  const proxies = []

  if (opts.L) {
    for (const local of opts.L) {
      proxies.push(tunnel.local(local))
    }
  }

  if (opts.R) {
    for (const remote of opts.R) {
      proxies.push(tunnel.remote(remote))
    }
  }

  for (const proxy of proxies) {
    await proxy.ready()
  }

  console.log('Tunnel is ready!')

  const unregister = goodbye(close)

  return async function cleanup () {
    unregister()

    await close()
  }

  async function close () {
    for (const proxy of proxies) {
      await proxy.close()
    }
    await tunnel.close()
    await hs.destroy()
  }
}
