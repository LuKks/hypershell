const fs = require('fs')
const crypto = require('hypercore-crypto')
const HypercoreId = require('hypercore-id-encoding')

module.exports = async function fileToKeyPair (filename) {
  const key = await fs.promises.readFile(filename, 'utf8')
  const seed = HypercoreId.decode(key.trim())
  const keyPair = crypto.keyPair(seed)

  return keyPair
}
