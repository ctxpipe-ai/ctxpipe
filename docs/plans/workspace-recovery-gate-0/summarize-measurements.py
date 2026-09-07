"""Summarize captured HTTP/SSE samples without treating missing phases as zero."""
import json
import math
import pathlib
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: summarize-measurements.py captured-samples.jsonl')
rows = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
samples = [row for row in rows if row['kind'] == 'sample']

def quantiles(values):
    values = sorted(values)
    return None if not values else {
        'n': len(values),
        'p50': values[math.ceil(len(values) * .50) - 1],
        'p95': values[math.ceil(len(values) * .95) - 1],
        'max': values[-1],
    }

result = {'source': sys.argv[1], 'quantile_method': 'nearest rank; milliseconds', 'groups': {}}
for temperature in ('cold', 'warm'):
    group = [row for row in samples if row['temperature'] == temperature]
    metrics = {name: [] for name in ('workspace', 'prepare', 'first_event', 'first_text', 'terminal', 'send_completion', 'history_read')}
    sessions, directories, history_lengths = [], [], []
    passed = 0
    for sample in group:
        events = sample['send']['events']
        for name in ('workspace', 'prepare'):
            metrics[name].append(sample[name]['duration_ms'])
        metrics['send_completion'].append(sample['send']['duration_ms'])
        metrics['history_read'].append(sample['history']['duration_ms'])
        for name, selected in (
            ('first_event', events),
            ('first_text', [e for e in events if e['event'].get('type') == 'TEXT_MESSAGE_CONTENT']),
            ('terminal', [e for e in events if e['event'].get('type') in ('RUN_FINISHED', 'RUN_ERROR')]),
        ):
            if selected:
                metrics[name].append(selected[0]['received_ms'])
        text = ''.join(e['event'].get('delta', '') for e in events if e['event'].get('type') == 'TEXT_MESSAGE_CONTENT')
        terminal = [e['event']['type'] for e in events if e['event'].get('type') in ('RUN_FINISHED', 'RUN_ERROR')]
        passed += sample['send'].get('status') == 200 and terminal == ['RUN_FINISHED'] and 'Clockwork' in text
        for event in events:
            value = event['event']
            if value.get('name') == 'opencode.session-id':
                sessions.append(value['value']['sessionId'])
            if value.get('name') == 'sandbox.file':
                match = re.search(r'tanstack-ai-sandboxes/([\w-]+)', value['value'].get('path', ''))
                if match:
                    directories.append(match[1])
        history_lengths.append(len(json.loads(sample['history']['body'])['messages']))
    result['groups'][temperature] = {
        'metrics': {name: quantiles(values) for name, values in metrics.items()},
        'turn_oracle_passed': passed, 'turn_oracle_failed': len(group) - passed,
        'distinct_opencode_sessions': len(set(sessions)),
        'distinct_sandbox_directories': len(set(directories)),
        'history_message_counts': history_lengths,
    }
print(json.dumps(result, indent=2))
