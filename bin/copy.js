const { createCommand } = require('commander')

module.exports = createCommand('copy')
  .description('transfer files using a P2P server')
  .argument('<source>', 'Source')
  .argument('<target>', 'Target')
  .option('-f <filename>', 'filename of the seed key file')
  .option('--bootstrap <nodes...>', 'custom dht nodes')
  .action(require('../lib/bin/copy.js'))
