const path = require('path')
const cp = require('child_process')

const BIN_HYPERSHELL = path.join(__dirname, '..', '..', 'bin.js')

module.exports = {
  hypershell,
  hypershellSpawn,
  closeProcess,
  waitForLog
}

function hypershell (subcommand, args) {
  args.unshift(subcommand)
  args.unshift(BIN_HYPERSHELL)

  return cp.execFileSync(process.execPath, args.filter(v => v), { encoding: 'utf8' })
}

async function hypershellSpawn (t, subcommand, args, opts = {}) {
  args.unshift(subcommand)
  args.unshift(BIN_HYPERSHELL)

  const sp = cp.spawn(process.execPath, args, { timeout: 15000 })

  t.teardown(async () => {
    if (sp.killed) return

    sp.kill()

    await new Promise(resolve => sp.once('close', resolve))
  })

  sp.stdout.setEncoding('utf8')
  sp.stderr.setEncoding('utf8')

  sp.on('error', (error) => t.fail('spawn error: ' + error.message))
  sp.stderr.on('data', (data) => t.fail('spawn stderr: ' + data.toString()))

  if (opts.verbose) {
    sp.stdout.on('data', console.log)
    sp.stderr.on('data', console.log)
  }

  await waitForProcess(sp)

  return sp
}

async function closeProcess (sp) {
  if (sp.killed) return

  sp.kill()

  await new Promise(resolve => sp.once('close', resolve))
}

function waitForProcess (child) {
  return new Promise((resolve, reject) => {
    child.on('spawn', done)
    child.on('error', done)

    function done (err) {
      child.removeListener('spawn', done)
      child.removeListener('error', done)
      err ? reject(err) : resolve()
    }
  })
}

function waitForLog (child, message) {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', ondata)
    child.stderr.on('data', onstderror)
    child.on('error', onerror)

    function cleanup () {
      child.stdout.removeListener('data', ondata)
      child.stderr.removeListener('data', onstderror)
      child.removeListener('error', onerror)
    }

    function ondata (data) {
      if (data.includes(message)) {
        cleanup()
        resolve()
      }
    }

    function onstderror (data) {
      cleanup()
      reject(new Error(data))
    }

    function onerror (err) {
      cleanup()
      reject(err)
    }
  })
}
