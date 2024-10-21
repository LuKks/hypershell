const crayon = require('tiny-crayon')
const getPrimaryKeys = require('../get-primary-keys.js')
const KnownPeers = require('../known-peers.js')

module.exports = async function keysList (opts = {}) {
  console.log('Public keys:')

  const primaryKeys = await getPrimaryKeys()

  if (primaryKeys.length) {
    for (const primary of primaryKeys) {
      console.log('-', crayon.magenta(primary.name), crayon.green(primary.publicKey))
    }
  } else {
    console.log('- No keys found')
  }

  console.log()
  console.log('Known peers:')

  const knownPeers = new KnownPeers()
  const peers = await knownPeers.list()

  if (peers.length) {
    for (const peer of peers) {
      console.log('-', crayon.magenta(peer.name), crayon.green(peer.publicKey))
    }
  } else {
    console.log('- No keys found')
  }
}
