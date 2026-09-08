import os,pathlib,subprocess,tempfile,tarfile,io,json,shutil,uuid
root=pathlib.Path(__file__).resolve().parents[3]
admin=os.environ['DATABASE_URL']
psql=shutil.which('psql') or '/opt/homebrew/opt/libpq/bin/psql'
from urllib.parse import urlsplit
if urlsplit(admin).hostname not in ('127.0.0.1','localhost','::1'):
 raise SystemExit('This proof requires a disposable local Postgres')
node=os.environ.get('NODE_BINARY') or shutil.which('node')
if not node:raise SystemExit('Node is required')
def sql(url,statement):
 return subprocess.check_output([psql,url,'-v','ON_ERROR_STOP=1','-Atc',statement],text=True)
for mode in ['fresh','upgrade']:
 name='ctxpipe_gate2_'+mode+'_'+uuid.uuid4().hex[:8]
 url=admin.rsplit('/',1)[0]+'/'+name
 print('Creating',name,flush=True);sql(admin,'CREATE DATABASE '+name)
 try:
  with tempfile.TemporaryDirectory(prefix='.gate2-migrations-',dir=root/'apps/backend') as tmp:
   tmp=pathlib.Path(tmp)
   for phase in (['previous','current'] if mode=='upgrade' else ['current']):
    dest=tmp/phase
    if phase=='previous':
     archive=subprocess.check_output(['git','archive','d87858354a783a9fd95c46785208c9b699a45e3b','apps/backend/migrations'],cwd=root)
     with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(dest)
     migrations=dest/'apps/backend/migrations'
    else:
     migrations=dest;shutil.copytree(root/'apps/backend/migrations',dest)
    config=tmp/'drizzle.config.ts'
    config.write_text('import {defineConfig} from "drizzle-kit";export default defineConfig({dialect:"postgresql",out:'+json.dumps(str(migrations))+',dbCredentials:{url:process.env.DATABASE_URL!}})')
    print('Migrating',mode,phase,flush=True)
    subprocess.run([node,str(root/'apps/backend/node_modules/drizzle-kit/bin.cjs'),'migrate','--config',str(config)],cwd=root/'apps/backend',env={**os.environ,'DATABASE_URL':url},check=True)
    if phase=='previous':
     sql(url,"INSERT INTO organizations(id,name,slug,created_at) VALUES ('org_gate2_upgrade','Gate 2 migration','gate2-migration',now()); INSERT INTO workspaces(id,org_id,slug,display_name,workspace_repository_url,desired_sha,active_projection_url,active_projection_sha) VALUES ('ws_gate2_upgrade','org_gate2_upgrade','knowledge','Legacy knowledge','https://example.test/legacy.git',repeat('a',40),'https://example.test/legacy.git',repeat('a',40));")
   columns=sql(url,"SELECT column_name FROM information_schema.columns WHERE table_name='workspaces' AND column_name IN ('active_revision','desired_default_branch') ORDER BY column_name;").splitlines()
   assert columns==['active_revision','desired_default_branch'],columns
   if mode=='upgrade':
    preserved=sql(url,"SELECT active_revision IS NULL AND desired_default_branch IS NULL AND active_projection_sha=repeat('a',40) AND desired_sha=repeat('a',40) FROM workspaces WHERE id='ws_gate2_upgrade';").strip()
    assert preserved=='t',preserved
   print('PASS',mode,'new nullable identity columns; legacy projection preserved' if mode=='upgrade' else 'complete fresh schema',flush=True)
 finally:
  print('Dropping',name,flush=True);sql(admin,'DROP DATABASE '+name+' WITH (FORCE)')
