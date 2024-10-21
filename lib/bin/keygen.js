const fs = require('fs')
const path = require('path')
const crypto = require('hypercore-crypto')
const HypercoreId = require('hypercore-id-encoding')
const crayon = require('tiny-crayon')
const constants = require('../constants.js')
const question = require('../question.js')

module.exports = async function keygen (opts = {}) {
  let {
    f: filename = path.join(constants.dir, 'id'),
    comment = opts.comment ? (' # ' + opts.comment) : ''
  } = opts

  if (!opts.f) {
    console.log('Enter file, "id_" will be prefixed unless the path is absolute or starts with a dot')

    const answer = await question('(' + filename + '): ')

    if (answer) {
      filename = answer
    }
  }

  const isName = !path.isAbsolute(filename) && filename[0] !== '.'

  if (isName) {
    if (!filename.startsWith('id')) {
      filename = 'id_' + filename
    }

    filename = path.join(constants.dir, filename)
  }

  filename = path.resolve(filename)

  if (fs.existsSync(filename)) {
    throw new Error('File already exists: ' + filename)
  }

  const seed = crypto.randomBytes(32)
  const keyPair = crypto.keyPair(seed)

  await fs.promises.mkdir(path.dirname(filename), { recursive: true })
  await fs.promises.writeFile(filename, HypercoreId.encode(seed) + comment + '\n', { flag: 'wx', mode: '600' })

  console.log('Your key has been saved in', crayon.green(filename))
  console.log('The public key is:')
  console.log(crayon.green(HypercoreId.encode(keyPair.publicKey)))

  return keyPair
}
