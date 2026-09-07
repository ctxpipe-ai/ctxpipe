"""Measure the real local HTTP chat contract; retain errors and censored samples."""
from datetime import datetime, timezone
import subprocess
import http.cookiejar
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid

if len(sys.argv) != 2:
    raise SystemExit('Usage: measure-http-baseline.py unique-output.jsonl')
output = pathlib.Path(sys.argv[1])
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(path, body=None, method=None, stream=False):
    req = urllib.request.Request('http://localhost:3010' + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={'Content-Type': 'application/json', 'Origin': 'http://localhost:3010'})
    started = time.perf_counter()
    result = {'path': path, 'method': req.get_method(), 'events': [], 'timeout_seconds': 60}
    try:
        try:
            response = client.open(req, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result['status'] = response.status
            if stream:
                for raw in response:
                    line = raw.decode().strip()
                    if line.startswith('data: '):
                        try:
                            event = json.loads(line[6:])
                        except json.JSONDecodeError:
                            event = {'unparsed': line[6:]}
                        result['events'].append({'received_ms': round((time.perf_counter()-started)*1000,2), 'event': event})
            else:
                result['body'] = response.read().decode()
    except (TimeoutError, OSError) as error:
        result['transport_error'] = str(error)
    result['duration_ms'] = round((time.perf_counter()-started)*1000,2)
    return result

login = request('/.auth/api/v1/auth/sign-in/email',
    {'email':'gate0@example.test','password':'gate0-disposable-local-password-20260907'})
if login.get('status') != 200:
    raise SystemExit('Disposable fixture login failed: ' + str(login.get('status')))
workspace = request('/gate-zero-local/api/v1/workspaces/remote')
workspace_id = json.loads(workspace['body'])['id']
with output.open('x') as log:
    log.write(json.dumps({'kind':'configuration','cold_definition':'new conversation and sandbox; prepare plus first send; backend and OS caches retained',
        'warm_definition':'same conversation after cold preparation; measured regardless of earlier result',
        'fixture':'known native Git SHA seeded after observed production tip-resolution failure',
        'transport':'real authenticated HTTP/SSE; not browser/WebSocket latency',
        'checkout_sha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'dirty_manifest':subprocess.check_output(['git','status','--porcelain'],text=True), 'product_source_sha':'1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8','workspace':workspace})+'\n')
    for cold_index in range(5):
        conversation_id = 'conv_gate0_measure_' + uuid.uuid4().hex[:16]
        path = '/gate-zero-local/api/v1/conversations/' + conversation_id
        for warm_index in range(21 if cold_index == 0 else 1):
            sample = {'kind':'sample','temperature':'cold' if warm_index == 0 else 'warm', 'conversation_id':conversation_id, 'started_at':datetime.now(timezone.utc).isoformat()}
            sample['workspace'] = request('/gate-zero-local/api/v1/workspaces/remote')
            sample['prepare'] = request(path+'/prepare',{'workspaceId':workspace_id})
            sample['send'] = request(path,{'workspaceId':workspace_id,'source':'ui',
                'message':{'role':'user','content':'What is the service name in README.md? Reply only with the service name.'}},stream=True)
            sample['history'] = request(path)
            sample['finished_at'] = datetime.now(timezone.utc).isoformat()
            sample['processes'] = subprocess.run(['pgrep','-fl','opencode serve'],text=True,capture_output=True).stdout
            sample['sockets'] = subprocess.run(['lsof','-nP','-iTCP:3010'],text=True,capture_output=True).stdout
            log.write(json.dumps(sample)+'\n');log.flush()
            print(sample['temperature'],conversation_id,sample['send']['duration_ms'],flush=True)
        cleanup = request(path,method='DELETE')
        log.write(json.dumps({'kind':'cleanup','conversation_id':conversation_id,'response':cleanup})+'\n');log.flush()
