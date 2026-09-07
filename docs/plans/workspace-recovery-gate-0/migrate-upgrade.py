"""Apply the PR merge-base schema then the PR-head schema to a new local database."""
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from urllib.parse import urlsplit, urlunsplit

root = pathlib.Path(__file__).resolve().parents[3]
admin_url = os.environ['DATABASE_URL']
parts = urlsplit(admin_url)
if parts.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise SystemExit('This baseline helper requires a disposable local Postgres.')
database_name = 'ctxpipe_gate0_upgrade_' + uuid.uuid4().hex[:12]
url = urlunsplit(parts._replace(path='/' + database_name))
psql = shutil.which('psql') or '/opt/homebrew/opt/libpq/bin/psql'
print('Creating disposable database:', database_name, flush=True)
subprocess.run([psql, admin_url, '-v', 'ON_ERROR_STOP=1', '-c',
                'CREATE DATABASE ' + database_name], check=True)
with tempfile.TemporaryDirectory(prefix='gate0-previous-') as previous, \
        tempfile.TemporaryDirectory(prefix='.gate0-upgrade-', dir=root / 'apps/backend') as configs:
    archive = subprocess.check_output([
        'git', 'archive', '9072089086f6fad87fbf05572b9f1ff5336e0520',
        'apps/backend/migrations'], cwd=root)
    archive_path = pathlib.Path(previous) / 'previous.tar'
    archive_path.write_bytes(archive)
    with tarfile.open(archive_path) as tar:
        tar.extractall(previous)
    config = pathlib.Path(configs) / 'drizzle.config.ts'
    for folder in (pathlib.Path(previous) / 'apps/backend/migrations',
                   root / 'apps/backend/migrations'):
        print('Migrating folder:', folder, flush=True)
        config.write_text(
            'import {defineConfig} from "drizzle-kit"; export default defineConfig({'
            'dialect:"postgresql",out:' + json.dumps(str(folder)) +
            ',dbCredentials:{url:process.env.DATABASE_URL!}})')
        command = ['volta', 'run', '--node', '22.16.0', 'pnpm', '--filter',
                   '@ctxpipe/backend', 'exec', 'drizzle-kit', 'migrate', '--config', str(config)]
        print('Command:', json.dumps(command), flush=True)
        subprocess.run(command, cwd=root, env={**os.environ, 'DATABASE_URL': url}, check=True)
print('Upgrade passed on database:', database_name, flush=True)
