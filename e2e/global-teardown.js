const { execFileSync } = require('node:child_process');

module.exports = async () => {
  if (process.env.KEEP_STACK) return; // to read `docker compose logs` after a failure
  // The volume stays: Foundry's download, licence and world take minutes to redo
  execFileSync('docker', ['compose', 'down'], { cwd: __dirname, stdio: 'inherit' });
};
