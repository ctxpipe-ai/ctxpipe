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
try:
    with tempfile.TemporaryDirectory(prefix='gate0-schemas-') as schemas, \
            tempfile.TemporaryDirectory(prefix='.gate0-upgrade-', dir=root / 'apps/backend') as configs:
        config = pathlib.Path(configs) / 'drizzle.config.ts'
        revisions = (
            ('base', '9072089086f6fad87fbf05572b9f1ff5336e0520'),
            ('head', '1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8'),
        )
        for label, revision in revisions:
            folder = pathlib.Path(schemas) / label
            folder.mkdir()
            archive = subprocess.check_output([
                'git', 'archive', revision, 'apps/backend/migrations'], cwd=root)
            archive_path = folder / 'schema.tar'
            archive_path.write_bytes(archive)
            with tarfile.open(archive_path) as tar:
                tar.extractall(folder)
            migrations = folder / 'apps/backend/migrations'
            print('Migrating revision:', revision, 'folder:', migrations, flush=True)
            config.write_text(
                'import {defineConfig} from "drizzle-kit"; export default defineConfig({'
                'dialect:"postgresql",out:' + json.dumps(str(migrations)) +
                ',dbCredentials:{url:process.env.DATABASE_URL!}})')
            command = ['volta', 'run', '--node', '22.16.0', 'pnpm', '--filter',
                       '@ctxpipe/backend', 'exec', 'drizzle-kit', 'migrate', '--config', str(config)]
            print('Command:', json.dumps(command), flush=True)
            subprocess.run(command, cwd=root, env={**os.environ, 'DATABASE_URL': url}, check=True)
    print('Upgrade passed on database:', database_name, flush=True)
finally:
    print('Dropping this invocation’s disposable database:', database_name, flush=True)
    subprocess.run([psql, admin_url, '-v', 'ON_ERROR_STOP=1', '-c',
                    'DROP DATABASE ' + database_name + ' WITH (FORCE)'], check=True)
