const fs = require('fs')
const path = require('path')
const configs = require('tiny-configs')
const HypercoreId = require('hypercore-id-encoding')
const constants = require('./constants.js')

module.exports = async function getKnownPeer (host, opts) {
  const peers = await readKnownPeers(opts)

  for (const peer of peers) {
    if (peer.name === host) {
      host = peer.publicKey
      break
    }
  }

  return HypercoreId.decode(host)
}

async function readKnownPeers (opts) {
  const filename = path.join(constants.dir, 'known_peers')

  if (!fs.existsSync(filename)) {
    if (opts && opts.verbose) {
      console.log('Notice: creating default known peers', filename)
    }

    await fs.promises.mkdir(path.dirname(filename), { recursive: true })
    await fs.promises.writeFile(filename, '# <name> <public key>\n', { flag: 'wx' })
  }

  try {
    const file = await fs.promises.readFile(filename, 'utf8')

    return configs.parse(file, { split: ' ', length: 2 })
      .map(m => ({ name: m[0], publicKey: m[1] }))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}
