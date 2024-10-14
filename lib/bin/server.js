const fs = require('fs')
const path = require('path')
const goodbye = require('graceful-goodbye')
const readFile = require('read-file-live')
const HypercoreId = require('hypercore-id-encoding')
const configs = require('tiny-configs')
const constants = require('../constants.js')
const keygen = require('./keygen.js')
const Hypershell = require('../../index.js')
const fileToKeyPair = require('../file-to-keypair.js')

const PROTOCOLS = ['shell', 'upload', 'download', 'tunnel']

module.exports = async function server (opts = {}) {
  const keyFilename = path.resolve(opts.f || path.join(constants.dir, 'id'))
  const firewallFilename = path.resolve(opts.firewall || path.join(constants.dir, 'authorized_peers'))
  const firewallEnabled = !opts.disableFirewall
  const protocols = opts.protocol || PROTOCOLS

  if (!fs.existsSync(keyFilename)) {
    await keygen({ filename: keyFilename })
  }

  if (firewallEnabled && !fs.existsSync(firewallFilename)) {
    console.log('Notice: creating default firewall', firewallFilename)

    await fs.promises.mkdir(path.dirname(firewallFilename), { recursive: true })
    await fs.promises.writeFile(firewallFilename, '# <public key>\n', { flag: 'wx' })
  }

  const hs = new Hypershell({
    bootstrap: opts.bootstrap
  })

  const server = hs.createServer({
    keyPair: await fileToKeyPair(keyFilename),
    verbose: true
  })

  let unregisterFirewall = null

  if (opts.disableFirewall) {
    server.firewall = null
  } else {
    unregisterFirewall = await handleFirewall(firewallFilename, function (keys) {
      server.firewall = keys
    })
  }

  await server.listen()

  if (protocols === PROTOCOLS) {
    console.log('To connect to this shell, on another computer run:')
    console.log('hypershell ' + HypercoreId.encode(server.publicKey))
  } else {
    console.log('Running server with restricted protocols')
    console.log('Server key: ' + HypercoreId.encode(server.publicKey))
  }
  console.log()

  const unregister = goodbye(close)

  return async function cleanup () {
    unregister()

    await close()
  }

  async function close () {
    await server.close()
    await hs.destroy()

    if (unregisterFirewall) {
      unregisterFirewall()
    }
  }
}

async function handleFirewall (filename, onchange) {
  let list = null

  try {
    list = await fs.promises.readFile(filename, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }

  onchange(read(list))

  return readFile(filename, buf => {
    onchange(read(buf))
  })

  function read (list) {
    const parsed = configs.parse(list)

    return parsed.map(v => HypercoreId.decode(v))
  }
}
