"""Run isolated Gate 0 services; caller supplies an authorized model key in environment."""
import os, pathlib, sys
root=pathlib.Path(__file__).resolve().parents[3]
env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','USER','TMPDIR','LANG','VOLTA_HOME','PNPM_HOME')}
env.update(AUTH_SECRET='gate0-local-disposable-test-secret-20260907',DATABASE_URL='postgresql://ctxpipe_app:ctxpipe@127.0.0.1:51498/ctxpipe_gate0_fresh',AUTH_BASE_URL='http://localhost:3010',AUTH_ALLOWED_ORIGINS='http://localhost:3010,http://localhost:3012',UI_PROXY_URL='http://localhost:3012',VITE_PUBLIC_API_URL='http://localhost:3010',PORT='3010',GRAPH_DB_URI='redis://127.0.0.1:6399',STORYBOOK_DISABLE_TELEMETRY='1')
cmd=['volta','run','--node','22.16.0','pnpm','--filter']
if sys.argv[1] in ('backend','worker'):
    env['MODEL_PROVIDER_API_KEY']=os.environ['MODEL_PROVIDER_API_KEY']
    cmd += (['@ctxpipe/backend','exec','bun','run','src/server.ts'] if sys.argv[1]=='backend' else ['@ctxpipe/backend','exec','openworkflow','worker','start'])
else: cmd += ['@ctxpipe/ui','exec','vite','dev','--host','127.0.0.1','--port','3012','--strictPort']
os.chdir(root)
print('Command:',cmd,flush=True)
os.execvpe(cmd[0],cmd,env)
