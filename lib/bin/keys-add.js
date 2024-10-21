const crayon = require('tiny-crayon')
const HypercoreId = require('hypercore-id-encoding')
const KnownPeers = require('../known-peers.js')
const constants = require('../constants.js')

module.exports = async function keysAdd (name, publicKey, opts = {}) {
  publicKey = HypercoreId.normalize(publicKey)

  const knownPeers = new KnownPeers({ cwd: constants.dir })

  await knownPeers.put(name, publicKey)

  if (!opts.silent) {
    console.log('Peer added', crayon.magenta(name), crayon.green(publicKey))
  }
}
