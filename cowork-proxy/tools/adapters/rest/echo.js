// cowork-proxy/tools/adapters/rest/echo.js
// Sentinel adapter — used by tests to verify the framework runs end to
// end without hitting any third party. Free, deterministic, two ops.

async function execute({ op, args }) {
  if (op === 'fail') {
    throw new Error('echo:fail (intentional, used to test error path)');
  }
  return {
    output: { pong: true, op, echoed: args, t: new Date().toISOString() },
    costUsd: 0,
  };
}

module.exports = { execute };
