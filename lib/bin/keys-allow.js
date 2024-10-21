const fs = require('fs')
const path = require('path')
const crayon = require('tiny-crayon')
const configs = require('tiny-configs')
const HypercoreId = require('hypercore-id-encoding')
const KnownPeers = require('../known-peers.js')
const constants = require('../constants.js')

module.exports = async function keysAllow (keyOrName, opts = {}) {
  const filename = path.resolve(opts.firewall || path.join(constants.dir, 'authorized_peers'))

  if (!fs.existsSync(filename)) {
    console.log('Notice: Creating default firewall', crayon.green(filename))

    await fs.promises.mkdir(path.dirname(filename), { recursive: true })
    await fs.promises.writeFile(filename, '# <public key>\n', { flag: 'wx' })
  }

  const knownPeers = new KnownPeers()
  const publicKey = HypercoreId.encode(await knownPeers.getPublicKey(keyOrName))

  const content = await fs.promises.readFile(filename, 'utf8')
  const authorized = configs.parse(content).map(HypercoreId.normalize)

  for (const authorizedPublicKey of authorized) {
    if (authorizedPublicKey === publicKey) {
      throw new Error('Public key is already allowed in the firewall')
    }
  }

  const name = await knownPeers.getNameByPublicKey(publicKey)
  const comment = name ? (' # ' + name) : ''

  await fs.promises.appendFile(filename, publicKey + comment + '\n', { flag: 'a' })

  console.log('Peer allowed: ' + (name ? crayon.magenta(name) + ' ' : '') + crayon.green(publicKey))
}
