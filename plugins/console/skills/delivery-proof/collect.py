#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description='Collect a private BB delivery diagnosis through its validated RPC.')
parser.add_argument('--thread', default=os.environ.get('BB_THREAD_ID'))
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = Path(args.output).expanduser()
if output.exists():
    parser.error('Output exists; choose a versioned private destination.')
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='bb-delivery-proof-') as directory:
    request = Path(directory) / 'input.json'
    request.write_text(json.dumps({'threadId': args.thread}))
    result = subprocess.run(['bb', 'plugin', 'rpc', 'call', 'navaigate-skin', 'delivery_diagnose', '--input-file', str(request), '--json'], capture_output=True, text=True, check=True)
    value = json.loads(result.stdout)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
print(f'Private diagnosis saved: {output}. Review before sharing; no upload was performed.')
