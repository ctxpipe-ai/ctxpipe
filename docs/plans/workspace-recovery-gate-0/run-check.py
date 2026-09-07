import json, os, pathlib, signal, subprocess, sys, time
root=pathlib.Path(__file__).resolve().parents[3]
out=root/'docs/plans/workspace-recovery-gate-0/logs'
out.mkdir(exist_ok=True)
name=sys.argv[1]; cmd=sys.argv[2:]
if cmd[0]=='pnpm': cmd=['volta','run','--node','22.16.0',*cmd]
env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','USER','TMPDIR','SHELL','LANG','VOLTA_HOME','PNPM_HOME')}
env.update({'AUTH_SECRET':'gate0-local-disposable-test-secret-20260907','DATABASE_URL':'postgresql://ctxpipe:ctxpipe@127.0.0.1:51498/ctxpipe_gate0_fresh','GRAPH_DB_URI':'redis://127.0.0.1:6399','CI':'true','NO_COLOR':'1','TURBO_TELEMETRY_DISABLED':'1','STORYBOOK_DISABLE_TELEMETRY':'1'})
if name.startswith('tests'):
 env['DATABASE_URL']=env['DATABASE_URL'].replace('ctxpipe:ctxpipe@','ctxpipe_app:ctxpipe@')
if name.startswith('opencode-live'): env['OPENCODE_LIVE']='1'
start=time.time()
with (out/(name+'.log')).open('w') as f:
 f.write('Command: '+json.dumps(cmd)+'\n'); f.flush()
 p=subprocess.Popen(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 try: code=p.wait(timeout=600)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try: p.wait(timeout=10)
  except subprocess.TimeoutExpired: os.killpg(p.pid,signal.SIGKILL);p.wait()
  code=124
result={'name':name,'command':cmd,'exit_code':code,'duration_seconds':round(time.time()-start,2),'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(start)),'log':'logs/'+name+'.log'}
(out/(name+'.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
