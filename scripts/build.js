const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

const pkgBin = path.join(ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
if (!fs.existsSync(pkgBin)) {
  console.error('pkg not found. Run: npm install');
  process.exit(1);
}

const target = 'node20-win-x64';
const exeName = 'ban-checker.exe';
const entryPoint = path.join(ROOT, 'update', 'server.js');
const configPath = path.join(ROOT, 'package.json');

console.log('Building ban-checker.exe...');
console.log(`Target: ${target}`);
console.log(`Entry: ${entryPoint}`);

try {
  execSync(`node "${pkgBin}" "${entryPoint}" --target ${target} --config "${configPath}" --output "${path.join(DIST, exeName)}"`, {
    cwd: ROOT,
    stdio: 'inherit'
  });
  console.log(`\nBuilt: ${path.join(DIST, exeName)}`);

  const stats = fs.statSync(path.join(DIST, exeName));
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  console.log(`Size: ${sizeMB} MB`);

  patchWindowsSubsystem(path.join(DIST, exeName));
} catch (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
}

function patchWindowsSubsystem(exePath) {
  try {
    const buf = fs.readFileSync(exePath);
    const peOffset = buf.readUInt32LE(0x3c);
    const magic = buf.readUInt16LE(peOffset + 0x18);
    let subsystemOffset;
    if (magic === 0x010b) {
      subsystemOffset = peOffset + 0x5c;
    } else if (magic === 0x020b) {
      subsystemOffset = peOffset + 0x5c;
    } else {
      console.log('Unknown PE format, skipping subsystem patch');
      return;
    }
    const currentSubsystem = buf.readUInt16LE(subsystemOffset);
    if (currentSubsystem === 3) {
      buf.writeUInt16LE(2, subsystemOffset);
      fs.writeFileSync(exePath, buf);
      console.log('Patched: GUI mode (no console window)');
    } else {
      console.log(`Subsystem already set to ${currentSubsystem}`);
    }
  } catch (e) {
    console.log('PE patch skipped:', e.message);
  }
}
