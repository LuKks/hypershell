const fs = require('fs')
const path = require('path')
const configs = require('tiny-configs')
const HypercoreId = require('hypercore-id-encoding')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const constants = require('./constants.js')
const getPrimaryKeys = require('./get-primary-keys.js')

module.exports = class KnownPeers extends ReadyResource {
  constructor () {
    super()

    this.filename = path.join(constants.dir, 'known_peers')

    this.ready().catch(safetyCatch)
  }

  async _open () {
    if (fs.existsSync(this.filename)) {
      return
    }

    await fs.promises.mkdir(path.dirname(this.filename), { recursive: true })
    await fs.promises.writeFile(this.filename, '# <name> <public key>\n', { flag: 'wx' })
  }

  async list () {
    if (this.opened === false) await this.opening

    let file = null

    try {
      file = await fs.promises.readFile(this.filename, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        return []
      }

      throw err
    }

    // TODO: Parse should also return the line index for del()
    const parsed = configs.parse(file, { split: ' ', length: 2 })

    return parsed.map(m => ({ name: m[0], publicKey: m[1] }))
  }

  async get (name) {
    name = name.trim()

    const peers = await this.list()

    for (const peer of peers) {
      if (name === peer.name) {
        return peer
      }
    }

    return null
  }

  async put (name, publicKey) {
    name = name.trim()
    publicKey = HypercoreId.normalize(publicKey.trim())

    if (name.startsWith('id')) {
      throw new Error('Peer name can not start with "id"')
    }

    const peers = await this.list()

    for (const peer of peers) {
      if (name === peer.name) {
        throw new Error('Peer name already exists: ' + peer.name)
      }

      if (publicKey === peer.publicKey) {
        throw new Error('Peer key already exists: (' + peer.name + ') ' + peer.publicKey)
      }
    }

    await fs.promises.appendFile(this.filename, name + ' ' + publicKey + '\n', { flag: 'a' })
  }

  async getPublicKey (host) {
    const peer = await this.get(host)

    try {
      // Match known peer by name
      if (peer) {
        return HypercoreId.decode(peer.publicKey)
      }

      // Match primary key by filename like "id" or "id_server"
      const primaryKeys = await getPrimaryKeys()

      for (const primary of primaryKeys) {
        if (host === primary.name) {
          return HypercoreId.decode(primary.publicKey)
        }
      }

      // Direct public key
      return HypercoreId.decode(host)
    } catch (err) {
      safetyCatch(err)

      throw new Error('Peer name not found or invalid public key')
    }
  }

  async getNameByPublicKey (publicKey) {
    const peers = await this.list()

    for (const peer of peers) {
      if (publicKey === peer.publicKey) {
        return peer.name
      }
    }

    return null
  }
}
