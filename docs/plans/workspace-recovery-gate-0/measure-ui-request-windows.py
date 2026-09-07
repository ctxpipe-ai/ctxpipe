import json,pathlib,re,time
source=pathlib.Path('/private/tmp/gate0-golden-backend-authorized.log')
start_offset=source.stat().st_size
started=time.monotonic()
ansi=re.compile(r'\x1b\[[0-9;]*m')
output=pathlib.Path(__file__).parent/'logs/ui-request-windows.jsonl'
with output.open('x') as log:
 for seconds in [5,30,60]:
  time.sleep(max(0,seconds-(time.monotonic()-started)))
  with source.open() as f:f.seek(start_offset);text=ansi.sub('',f.read())
  blocks=re.split(r'(?=^\d\d:\d\d:\d\d\.\d{3} )',text,flags=re.M)
  requests=[]
  for block in blocks:
   m=re.match(r'(\d\d:\d\d:\d\d\.\d{3}).*?\b(GET|POST|PUT|DELETE|PATCH) (/gate-zero-local/api/\S+) (\d{3})',block)
   if m and 'Chrome/152.0.0.0' in block:
    requests.append({'time':m[1],'method':m[2],'path':m[3],'status':int(m[4])})
  log.write(json.dumps({'window_seconds':seconds,'browser_session_user_agent':'Chrome/152.0.0.0','requests':requests,'count':len(requests),'page':'conversation README pane','limitation':'HTTP API request completion logs only; WebSocket frames excluded; no navigation during sample'})+'\n');log.flush()
  print(seconds,len(requests),flush=True)
