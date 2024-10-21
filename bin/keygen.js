const { createCommand } = require('commander')

module.exports = createCommand('keygen')
  .description('create keys of type ed25519')
  .option('-f <filename>', 'filename of the seed key file')
  .option('-c <comment>', 'provides a comment')
  .action(require('../lib/bin/keygen.js'))
