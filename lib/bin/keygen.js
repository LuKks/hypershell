const fs = require('fs')
const path = require('path')
const crypto = require('hypercore-crypto')
const HypercoreId = require('hypercore-id-encoding')
const constants = require('../constants.js')
const question = require('../question.js')

module.exports = async function keygen (opts = {}) {
  console.log(opts)
  let {
    f: filename = path.join(constants.dir, 'id'),
    comment = opts.comment ? (' # ' + opts.comment) : ''
  } = opts

  console.log('Generating key.', { filename })

  if (!opts.f) {
    const answer = await question('Enter file in which to save the key (' + filename + '): ')

    if (answer) {
      filename = answer
    }
  }

  filename = path.resolve(filename)

  if (fs.existsSync(filename)) {
    throw new Error('File already exists:' + filename)
  }

  const seed = crypto.randomBytes(32)
  const keyPair = crypto.keyPair(seed)

  await fs.promises.mkdir(path.dirname(filename), { recursive: true })
  await fs.promises.writeFile(filename, HypercoreId.encode(seed) + comment + '\n', { flag: 'wx', mode: '600' })

  console.log('Your key has been saved in', filename)
  console.log('The public key is:')
  console.log(HypercoreId.encode(keyPair.publicKey))

  return keyPair
}
