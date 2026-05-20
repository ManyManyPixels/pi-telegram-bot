const { execFile } = require("child_process");

/**
 * Promise wrapper around child_process.execFile.
 */
function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`)
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

module.exports = { execFilePromise };
