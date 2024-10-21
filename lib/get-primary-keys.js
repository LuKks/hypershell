const fs = require('fs')
const path = require('path')
const HypercoreId = require('hypercore-id-encoding')
const fileToKeyPair = require('./file-to-keypair.js')
const constants = require('./constants.js')

module.exports = async function getPrimaryKeys () {
  const files = await readdir(constants.dir)
  const primaryKeys = []

  for (const dirent of files) {
    if (!dirent.name.startsWith('id')) {
      continue
    }

    const filename = path.join(constants.dir, dirent.name)
    const keyPair = await fileToKeyPair(filename)
    const publicKey = HypercoreId.encode(keyPair.publicKey)

    primaryKeys.push({ name: dirent.name, publicKey })
  }

  return primaryKeys
}

async function readdir (dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
