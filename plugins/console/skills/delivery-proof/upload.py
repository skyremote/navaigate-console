#!/usr/bin/env python3
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse

DEFAULT_BRANCH = 'delivery-proof'
BRANCH_PATTERN = re.compile(r'^delivery-proof([/-][A-Za-z0-9._/-]{0,80})?$')
DEFAULT_MAX_BYTES = 50 * 1024 * 1024
MEDIA = {
    '.png': ('image/png', lambda head: head.startswith(b'\x89PNG\r\n\x1a\n'), True),
    '.jpg': ('image/jpeg', lambda head: head.startswith(b'\xff\xd8\xff'), True),
    '.jpeg': ('image/jpeg', lambda head: head.startswith(b'\xff\xd8\xff'), True),
    '.gif': ('image/gif', lambda head: head.startswith((b'GIF87a', b'GIF89a')), True),
    '.webp': ('image/webp', lambda head: head[:4] == b'RIFF' and head[8:12] == b'WEBP', True),
    '.mp4': ('video/mp4', lambda head: head[4:8] == b'ftyp', False),
    '.mov': ('video/quicktime', lambda head: head[4:8] in (b'ftyp', b'moov', b'wide', b'mdat'), False),
    '.webm': ('video/webm', lambda head: head.startswith(b'\x1a\x45\xdf\xa3'), False),
}
PR_URL = re.compile(r'^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)/?$')
REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')


class Failure(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def gh_api(endpoint, method='GET', body=None):
    command = ['gh', 'api']
    if method != 'GET':
        command += ['-X', method]
    command.append(endpoint)
    payload = None
    if body is not None:
        command += ['--input', '-']
        payload = json.dumps(body)
    try:
        result = subprocess.run(command, input=payload, capture_output=True, text=True)
    except FileNotFoundError:
        raise Failure('The GitHub CLI (gh) is not installed or not on PATH.')
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise Failure('gh api %s %s failed: %s' % (method, endpoint, detail[0] if detail else 'no detail'))
    return json.loads(result.stdout) if result.stdout.strip() else {}


def describe(path):
    if os.path.islink(path):
        raise Failure('%s is a symbolic link; pass the real file.' % path)
    if not os.path.isfile(path):
        raise Failure('%s is not a file.' % path)
    extension = os.path.splitext(path)[1].lower()
    if extension not in MEDIA:
        raise Failure('%s is not a supported screenshot or video (%s).' % (path, ', '.join(sorted(MEDIA))))
    size = os.path.getsize(path)
    if size == 0:
        raise Failure('%s is empty.' % path)
    with open(path, 'rb') as handle:
        data = handle.read()
    mime, sniff, inline = MEDIA[extension]
    if not sniff(data[:16]):
        raise Failure('%s does not look like %s data.' % (path, mime))
    name = re.sub(r'[^A-Za-z0-9._-]+', '-', os.path.basename(path)).strip('-.') or 'proof' + extension
    return {
        'source': path,
        'name': name,
        'bytes': size,
        'mime': mime,
        'inline': inline,
        'sha256': hashlib.sha256(data).hexdigest(),
        'data': data,
    }


def comment_body(files, note, branch, commit, policy):
    lines = ['<!-- delivery-proof -->', '### Delivery proof']
    if note:
        lines += ['', note.strip()]
    for item in files:
        lines.append('')
        lines.append(('![%s](%s)' if item['inline'] else '[%s](%s)') % (item['name'], item['url']))
    lines += ['', '| File | Bytes | SHA-256 |', '| --- | --- | --- |']
    for item in files:
        lines.append('| %s | %d | `%s` |' % (item['name'], item['bytes'], item['sha256']))
    lines += ['', 'Stored on branch `%s` at commit `%s`. %s' % (branch, commit, policy)]
    return '\n'.join(lines)


def preview_comment(files, note, branch, policy):
    placeholder = [dict(item, url='<url returned after upload>') for item in files]
    return comment_body(placeholder, note, branch, '<commit>', policy)


def store(repo, number, branch, files):
    base = 'repos/%s' % repo
    stamp = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    for item in files:
        item['path'] = 'pr-%d/%s/%s-%s' % (number, stamp, item['sha256'][:12], item['name'])
        blob = gh_api(base + '/git/blobs', 'POST', {'content': base64.b64encode(item['data']).decode('ascii'), 'encoding': 'base64'})
        item['blobSha'] = blob['sha']
    for attempt in range(3):
        head = None
        try:
            head = gh_api('%s/git/ref/heads/%s' % (base, urllib.parse.quote(branch)))['object']['sha']
        except Failure as error:
            if '404' not in str(error):
                raise
        tree_body = {'tree': [{'path': item['path'], 'mode': '100644', 'type': 'blob', 'sha': item['blobSha']} for item in files]}
        if head:
            tree_body['base_tree'] = gh_api('%s/git/commits/%s' % (base, head))['tree']['sha']
        tree = gh_api(base + '/git/trees', 'POST', tree_body)
        commit = gh_api(base + '/git/commits', 'POST', {
            'message': 'Delivery proof for pull request #%d' % number,
            'tree': tree['sha'],
            'parents': [head] if head else [],
        })
        try:
            if head:
                gh_api('%s/git/refs/heads/%s' % (base, urllib.parse.quote(branch)), 'PATCH', {'sha': commit['sha'], 'force': False})
            else:
                gh_api(base + '/git/refs', 'POST', {'ref': 'refs/heads/%s' % branch, 'sha': commit['sha']})
            return commit['sha']
        except Failure:
            if attempt == 2:
                raise
    raise Failure('Could not update the proof branch.')


def verify(repo, commit, item):
    found = gh_api('repos/%s/contents/%s?ref=%s' % (repo, urllib.parse.quote(item['path']), commit))
    return found.get('sha') == item['blobSha'] and found.get('size') == item['bytes']


def branch_conflict(branch, info, pull):
    if branch == info.get('default_branch'):
        return '%s is the default branch; proof is never stored on it.' % branch
    if branch == (pull.get('head') or {}).get('ref'):
        return '%s is the head branch of this pull request; proof is never stored in the code under review.' % branch
    if branch == (pull.get('base') or {}).get('ref'):
        return '%s is the base branch of this pull request; proof is never stored on it.' % branch
    return None


def main():
    parser = argparse.ArgumentParser(description='Upload reviewed proof screenshots or videos beside a pull request and return GitHub-hosted URLs.')
    parser.add_argument('files', nargs='+', help='Media files, optionally preceded by a pull request URL.')
    parser.add_argument('--repo', help='owner/name of the repository that owns the pull request.')
    parser.add_argument('--pr', help='Pull request number or URL.')
    parser.add_argument('--note', default='', help='Text placed above the media in the comment.')
    parser.add_argument('--branch', default=DEFAULT_BRANCH, help='Dedicated branch that stores proof media.')
    parser.add_argument('--max-bytes', type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument('--receipt', help='Write the receipt to this new private file.')
    parser.add_argument('--no-comment', action='store_true', help='Store the media and return URLs without commenting.')
    parser.add_argument('--upload', action='store_true', help='Perform the upload. Without it the command only previews.')
    parser.add_argument('--confirm-redacted', action='store_true', help='Confirm every file has been inspected and redacted for sharing.')
    args = parser.parse_intermixed_args()

    paths = list(args.files)
    target = args.pr
    if paths and PR_URL.match(paths[0]):
        target = target or paths[0]
        paths = paths[1:]
    if not paths:
        parser.error('Give at least one media file.')
    if not target:
        parser.error('Give the pull request with --pr (and --repo) or as a pull request URL.')
    repo = args.repo
    matched = PR_URL.match(str(target))
    if matched:
        repo = repo or matched.group(1)
        if repo != matched.group(1):
            parser.error('--repo does not match the pull request URL.')
        number = int(matched.group(2))
    elif str(target).isdigit():
        number = int(target)
    else:
        parser.error('--pr must be a number or a pull request URL.')
    if not repo or not REPO.match(repo):
        parser.error('Give the repository as --repo owner/name.')
    if not BRANCH_PATTERN.match(args.branch) or '..' in args.branch or '//' in args.branch or args.branch.endswith(('/', '.')) or '.lock' in args.branch:
        parser.error('--branch must be a dedicated branch named delivery-proof or starting with delivery-proof/ or delivery-proof-.')
    if args.upload and not args.confirm_redacted:
        parser.error('--upload needs --confirm-redacted: inspect and redact every file first.')
    receipt_path = os.path.expanduser(args.receipt) if args.receipt else None
    if receipt_path and os.path.exists(receipt_path):
        parser.error('Receipt path exists; choose a new private destination.')

    try:
        files = [describe(os.path.expanduser(path)) for path in paths]
        for item in files:
            if item['bytes'] > args.max_bytes:
                raise Failure('%s is %d bytes, above the limit of %d.' % (item['source'], item['bytes'], args.max_bytes))
        public_files = [{key: value for key, value in item.items() if key not in ('data', 'source')} for item in files]
        if not args.upload:
            plan = {
                'uploaded': False,
                'repo': repo,
                'pr': number,
                'branch': args.branch,
                'files': public_files,
                'proposedComment': preview_comment(files, args.note, args.branch, 'Access follows the repository.'),
                'next': 'Re-run with --upload --confirm-redacted to store the files and post the comment.',
            }
            print(json.dumps(plan, indent=2))
            return 0

        info = gh_api('repos/%s' % repo)
        pull = gh_api('repos/%s/pulls/%d' % (repo, number))
        if pull.get('state') != 'open':
            raise Failure('Pull request #%d is %s; proof is only added to open pull requests.' % (number, pull.get('state')))
        conflict = branch_conflict(args.branch, info, pull)
        if conflict:
            raise Failure(conflict)
        if info.get('private'):
            policy = 'Private repository: visible only to people with read access to %s.' % repo
        else:
            policy = 'Public repository: anyone can view this media.'
        commit = store(repo, number, args.branch, files)
        for item in files:
            item['url'] = 'https://github.com/%s/blob/%s/%s?raw=true' % (repo, commit, urllib.parse.quote(item['path']))
            item['verified'] = verify(repo, commit, item)
        if not all(item['verified'] for item in files):
            raise Failure('Stored bytes could not be verified against the upload; no comment was posted.')
        receipt = {
            'uploaded': True,
            'repo': repo,
            'pr': number,
            'prUrl': pull.get('html_url'),
            'branch': args.branch,
            'commit': commit,
            'uploadedAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'accessPolicy': policy,
            'expiry': 'None: kept until the %s branch is deleted.' % args.branch,
            'files': [{key: value for key, value in item.items() if key not in ('data', 'source', 'inline')} for item in files],
            'comment': None,
        }
        status = 0
        if not args.no_comment:
            try:
                body = comment_body(files, args.note, args.branch, commit, policy)
                posted = gh_api('repos/%s/issues/%d/comments' % (repo, number), 'POST', {'body': body})
                reread = gh_api('repos/%s/issues/comments/%s' % (repo, posted['id']))
                intact = all(item['url'] in reread.get('body', '') for item in files)
                receipt['comment'] = {'id': posted['id'], 'url': posted['html_url'], 'verified': intact}
                if not intact:
                    receipt['error'] = 'The comment was posted but the re-read body is missing media URLs.'
                    status = 4
            except Failure as error:
                receipt['error'] = 'The media is stored but the comment failed: %s' % error
                status = 3
        text = json.dumps(receipt, indent=2)
        if receipt_path:
            os.makedirs(os.path.dirname(os.path.abspath(receipt_path)), exist_ok=True)
            fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as handle:
                handle.write(text + '\n')
        print(text)
        return status
    except Failure as error:
        sys.stderr.write('%s\n' % error)
        return error.code


if __name__ == '__main__':
    sys.exit(main())
