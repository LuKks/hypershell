const { createCommand } = require('commander')

const keys = createCommand('keys')
  .description('keys management')

keys
  .command('list')
  .description('list keys')
  .action(require('../lib/bin/keys-list.js'))

keys
  .command('add <name> <public-key>')
  .description('add a known peer by name')
  .action(require('../lib/bin/keys-add.js'))

keys
  .command('allow <public-key-or-name>')
  .description('authorize a peer into the server')
  .option('--firewall <filename>', 'list of allowed public keys')
  .action(require('../lib/bin/keys-allow.js'))

module.exports = keys
