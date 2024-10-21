#!/usr/bin/env node

const { program } = require('commander')
const safetyCatch = require('safety-catch')
const pkg = require('./package.json')

const main = program
  .version(pkg.version)
  .description(pkg.description)
  .addCommand(require('./bin/server.js'))
  .addCommand(require('./bin/login.js'))
  .addCommand(require('./bin/copy.js'))
  .addCommand(require('./bin/tunnel.js'))
  .addCommand(require('./bin/keygen.js'))
  .addCommand(require('./bin/keys.js'))

main.parseAsync().catch(err => {
  safetyCatch(err)
  console.error('error: ' + err.message)
  process.exit(1)
})
