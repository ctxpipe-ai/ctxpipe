import os, pathlib, subprocess, tarfile, tempfile
root=pathlib.Path.cwd()
url=os.environ['DATABASE_URL'].rsplit('/',1)[0]+'/ctxpipe_gate0_upgrade'
subprocess.run(['/opt/homebrew/opt/libpq/bin/psql',os.environ['DATABASE_URL'],'-v','ON_ERROR_STOP=1','-c','CREATE DATABASE ctxpipe_gate0_upgrade'],check=True)
with tempfile.TemporaryDirectory(prefix='gate0-previous-') as td:
 archive=subprocess.check_output(['git','archive','9072089086f6fad87fbf05572b9f1ff5336e0520','apps/backend/migrations'])
 arc=pathlib.Path(td)/'previous.tar';arc.write_bytes(archive)
 with tarfile.open(arc) as tf: tf.extractall(td)
 config=root/'apps/backend/gate0-upgrade.config.ts'
 try:
  for folder in [pathlib.Path(td)/'apps/backend/migrations',root/'apps/backend/migrations']:
   print('Migrating folder:',folder,flush=True)
   config.write_text('import {defineConfig} from "drizzle-kit"; export default defineConfig({dialect:"postgresql",out:'+repr(str(folder))+',dbCredentials:{url:process.env.DATABASE_URL!}})')
   subprocess.run(['pnpm','--filter','@ctxpipe/backend','exec','drizzle-kit','migrate','--config',str(config)],env={**os.environ,'DATABASE_URL':url},check=True)
 finally: config.unlink(missing_ok=True)
