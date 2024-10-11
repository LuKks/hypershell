const readline = require('readline')

module.exports = function question (query) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    rl.question(query, function (answer) {
      rl.close()

      resolve(answer.trim())
    })
  })
}
