const { createCommand } = require('commander')

module.exports = createCommand('login')
  .description('connect to a P2P shell')
  .argument('<key or name>', 'public key or name of the server')
  .option('-f <filename>', 'filename of the client seed key')
  .option('--bootstrap <nodes...>', 'custom dht nodes')
  .action(require('../lib/bin/login.js'))
