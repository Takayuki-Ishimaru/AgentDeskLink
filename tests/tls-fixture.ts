import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';

const config = `[req]
prompt = no
distinguished_name = subject
x509_extensions = extensions
[subject]
CN = test.invalid
[extensions]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
subjectAltName = DNS:test.invalid,IP:127.0.0.1
`;

function openssl(): string {
  if (process.platform === 'win32') {
    try {
      const core = execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
      const bundled = resolve(core, '../../../usr/bin/openssl.exe');
      if (existsSync(bundled)) return bundled;
    } catch {
      // OpenSSL can also be installed independently on PATH.
    }
  }
  return 'openssl';
}

/** Creates a fresh key for a loopback TLS test. The temporary key file is removed before returning. */
export function generateTlsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'adl-test-tls-'));
  const keyPath = join(dir, 'key.pem');
  const configPath = join(dir, 'openssl.cnf');
  try {
    writeFileSync(configPath, config);
    const cert = execFileSync(
      openssl(),
      [
        'req',
        '-new',
        '-x509',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        '1',
        '-config',
        configPath,
        '-keyout',
        keyPath,
      ],
      { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return { key: readFileSync(keyPath), cert };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function trustedTlsOptions() {
  const key = process.env.ADL_TLS_FIXTURE_KEY;
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (process.env.ADL_TLS_TRUSTED !== '1' || !key || !caPath) throw new Error('Missing child TLS fixture');
  return { key: Buffer.from(key, 'base64'), cert: readFileSync(caPath) };
}

export async function startTrustedTlsChild(t: TestContext): Promise<void> {
  const { cert, key } = generateTlsFixture();
  const dir = mkdtempSync(join(tmpdir(), 'adl-test-ca-'));
  const caPath = join(dir, 'ca.pem');
  try {
    // The child trusts only this fixture in addition to its usual roots. Production TLS checks stay enabled.
    writeFileSync(caPath, cert, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: caPath,
      ADL_TLS_FIXTURE_KEY: key.toString('base64'),
      ADL_TLS_TRUSTED: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      ['--test', '--test-timeout=10000', '--test-force-exit', ...process.argv.slice(1)],
      {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('trusted child timed out'));
      }, 30000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        t.diagnostic(`trusted child exit code ${String(code)}`);
        if (code === 0) resolve();
        else reject(new Error(`trusted child failed with code ${String(code)}`));
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
