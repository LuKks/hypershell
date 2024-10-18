const fs = require('fs')
const path = require('path')
const goodbye = require('graceful-goodbye')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const getKnownPeer = require('../get-known-peer.js')
const fileToKeyPair = require('../file-to-keypair.js')
const Hypershell = require('../../index.js')

module.exports = async function tunnel (keyOrName, opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))

  if (!fs.existsSync(keyFilename)) {
    await keygen({ f: keyFilename })
  }

  const serverPublicKey = await getKnownPeer(keyOrName, { verbose: true })

  const hs = new Hypershell({ bootstrap: opts.bootstrap })

  const tunnel = hs.tunnel(serverPublicKey, {
    keyPair: await fileToKeyPair(keyFilename)
  })

  let proxy = null

  if (opts.L) {
    proxy = await tunnel.local(opts.L)
  } else if (opts.R) {
    proxy = await tunnel.remote(opts.R)
  } else {
    throw new Error('-L o -R is required')
  }

  console.log('Tunnel is ready!')

  const unregister = goodbye(close)

  return async function cleanup () {
    unregister()

    await close()
  }

  async function close () {
    await proxy.close()
    await tunnel.close()
    await hs.destroy()
  }
}
