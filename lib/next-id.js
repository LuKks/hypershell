module.exports = function nextId () {
  let id = 1

  return function () {
    if (id === 0xffffffff) {
      id = 1
    }

    return id++
  }
}
