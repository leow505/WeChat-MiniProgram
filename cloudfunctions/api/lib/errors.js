/**
 * Business failures carry a stable code and no prose — the client localizes it
 * (§10.1). `fail()` throws so callers read as straight-line code.
 */
class AppError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new AppError(code)
}

module.exports = { AppError, fail }
