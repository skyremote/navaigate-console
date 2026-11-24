"""Contract tests for extras/antigravity/add-to-bb.sh against a synthetic bb and agy."""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'extras' / 'antigravity' / 'add-to-bb.sh'
FAKE_BB = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['TEST_CALLS'], 'a', encoding='utf-8') as f: f.write(json.dumps(args)+'\\n')
if args == ['plugin', 'config', 'provider-acp', '--json']:
    if os.environ.get('TEST_FAIL_READ'): sys.exit(1)
    if os.environ.get('TEST_NOT_OK'): print(json.dumps({'ok': False, 'values': {}}))
    else: sys.stdout.buffer.write(json.dumps({'ok': True, 'values': {'customAgents': os.environ.get('TEST_AGENTS', '')}}, ensure_ascii=False).encode('utf-8'))
elif args[:5] == ['plugin', 'config', 'provider-acp', 'set', 'customAgents']:
    if os.environ.get('TEST_FAIL_SET'): sys.exit(1)
elif args == ['provider', 'models', 'acp-antigravity']:
    if os.environ.get('TEST_NO_MODELS'): sys.exit(1)
    print('test-model')
'''
FAKE_AGY = '''#!/bin/sh
[ "$1" = "acp" ] && [ "$2" = "--help" ] && [ -z "$TEST_AGY_NO_ACP" ] && exit 0
exit 1
'''
OTHER = {'id': 'mine', 'displayName': 'Mine', 'command': '/opt/mine', 'args': ['--acp'], 'env': {'MY_API_KEY': 'sk-test-not-a-real-key'}}


class AntigravityHelper(unittest.TestCase):
    def run_helper(self, *args, agents='', agy=True, bin_name='bin', **env):
        tmp = Path(tempfile.mkdtemp())
        bindir = tmp / bin_name
        bindir.mkdir()
        tools = {'bb': FAKE_BB}
        if agy:
            tools['agy'] = FAKE_AGY
        for name, body in tools.items():
            path = bindir / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        calls = tmp / 'calls'
        calls.write_text('')
        full_env = {'PATH': f'{bindir}:/usr/bin:/bin', 'HOME': str(tmp), 'TEST_CALLS': str(calls), 'TEST_AGENTS': agents}
        full_env.update(env)
        proc = subprocess.run(['bash', str(HELPER), *args], env=full_env, capture_output=True, text=True)
        done = [json.loads(line) for line in calls.read_text(encoding='utf-8').splitlines()]
        sets = [c[5] for c in done if c[:5] == ['plugin', 'config', 'provider-acp', 'set', 'customAgents']]
        return proc, sets, str(bindir / 'agy')

    def test_adds_to_an_empty_setting(self):
        proc, sets, agy = self.run_helper()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(sets[0]), [{'id': 'antigravity', 'displayName': 'Google Antigravity', 'command': agy, 'args': ['acp']}])
        self.assertIn('test-model', proc.stdout)

    def test_keeps_agents_that_are_already_there(self):
        proc, sets, agy = self.run_helper(agents=json.dumps([OTHER]))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        saved = json.loads(sets[0])
        self.assertEqual(saved[0], OTHER)
        self.assertEqual(saved[1]['id'], 'antigravity')
        self.assertEqual(len(saved), 2)

    def test_moves_only_the_command_of_an_existing_entry(self):
        existing = json.dumps([OTHER, {'id': 'antigravity', 'displayName': 'Google Antigravity', 'command': 'PLACEHOLDER', 'args': ['acp']}])
        proc, sets, agy = self.run_helper(agents=existing)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        saved = json.loads(sets[0])
        self.assertEqual(saved[0], OTHER)
        self.assertEqual(saved[1], {'id': 'antigravity', 'displayName': 'Google Antigravity', 'command': agy, 'args': ['acp']})
        self.assertIn('Pointed', proc.stdout)

    def test_same_entry_means_no_write(self):
        # Built by hand so the saved command can match the agy path before the run.
        tmp = Path(tempfile.mkdtemp())
        bindir = tmp / 'bin'
        bindir.mkdir()
        (bindir / 'bb').write_text(FAKE_BB)
        (bindir / 'agy').write_text(FAKE_AGY)
        for name in ('bb', 'agy'):
            (bindir / name).chmod(0o755)
        calls = tmp / 'calls'
        calls.write_text('')
        existing = json.dumps([{'id': 'antigravity', 'displayName': 'Renamed by me', 'command': str(bindir / 'agy'), 'args': ['acp']}])
        env = {'PATH': f'{bindir}:/usr/bin:/bin', 'HOME': str(tmp), 'TEST_CALLS': str(calls), 'TEST_AGENTS': existing}
        proc = subprocess.run(['bash', str(HELPER)], env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn('"set"', calls.read_text())
        self.assertIn('already in bb', proc.stdout)

    def test_dry_run_writes_nothing(self):
        proc, sets, _ = self.run_helper('--dry-run', agents=json.dumps([OTHER]))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sets, [])
        self.assertIn('"id": "antigravity"', proc.stdout)
        self.assertIn('plus 1 other custom agent, unchanged', proc.stdout)

    def test_dry_run_never_shows_another_agents_contents(self):
        proc, sets, _ = self.run_helper('--dry-run', agents=json.dumps([OTHER]))
        for private in ('sk-test-not-a-real-key', 'MY_API_KEY', '/opt/mine', '"mine"'):
            self.assertNotIn(private, proc.stdout + proc.stderr)

    def test_a_real_run_never_shows_another_agents_contents(self):
        proc, sets, _ = self.run_helper(agents=json.dumps([OTHER]))
        self.assertEqual(len(sets), 1)
        for private in ('sk-test-not-a-real-key', 'MY_API_KEY'):
            self.assertNotIn(private, proc.stdout + proc.stderr)

    def test_dry_run_of_a_moved_agy_writes_nothing(self):
        existing = json.dumps([{'id': 'antigravity', 'displayName': 'Google Antigravity', 'command': '/old/agy', 'args': ['acp']}])
        proc, sets, agy = self.run_helper('--dry-run', agents=existing)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sets, [])
        self.assertIn(agy, proc.stdout)

    def test_a_not_ok_reply_from_bb_writes_nothing(self):
        proc, sets, _ = self.run_helper(TEST_NOT_OK='1')
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(sets, [])
        self.assertIn('nothing was changed', proc.stderr)

    def test_extra_args_and_fields_on_the_entry_are_kept(self):
        mine = {'id': 'antigravity', 'displayName': 'My Antigravity', 'command': '/old/agy', 'args': ['acp', '--sandbox'], 'env': {'X': 'y'}, 'dialect': 'grok'}
        proc, sets, agy = self.run_helper(agents=json.dumps([mine, OTHER]))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        saved = json.loads(sets[0])
        self.assertEqual(saved[0], dict(mine, command=agy))
        self.assertEqual(saved[1], OTHER)

    def test_args_that_do_not_start_with_acp_are_put_right(self):
        mine = {'id': 'antigravity', 'displayName': 'Google Antigravity', 'command': '/old/agy', 'args': ['--version']}
        proc, sets, agy = self.run_helper(agents=json.dumps([mine]))
        self.assertEqual(json.loads(sets[0]), [dict(mine, command=agy, args=['acp'])])

    def test_other_languages_and_odd_characters_come_back_the_same(self):
        odd = {'id': 'cafe', 'displayName': 'Café „Zürich“ $(id) `x` \'q\' "d"', 'command': '/opt/my tools/agent', 'args': ['a b', 'line\nbreak']}
        raw = json.dumps([odd], ensure_ascii=False)
        proc, sets, agy = self.run_helper(agents=raw)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(sets[0])[0], odd)
        self.assertIn('Café „Zürich“', sets[0])

    def test_a_latin_1_locale_does_not_garble_other_agents(self):
        odd = {'id': 'cafe', 'displayName': 'Café ü „Zürich“', 'command': '/opt/agent', 'args': []}
        for locale_name in ('en_US.ISO8859-1', 'C', 'POSIX'):
            proc, sets, _ = self.run_helper(agents=json.dumps([odd], ensure_ascii=False), LC_ALL=locale_name, LANG=locale_name)
            self.assertEqual(proc.returncode, 0, locale_name + proc.stderr)
            self.assertEqual(json.loads(sets[0])[0], odd, locale_name)

    def test_dry_run_leaves_out_a_missing_display_name(self):
        existing = json.dumps([{'id': 'antigravity', 'command': '/old/agy', 'args': ['acp']}])
        proc, sets, _ = self.run_helper('--dry-run', agents=existing)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn('null', proc.stdout)

    def test_an_agy_path_with_a_space_is_saved_whole(self):
        proc, sets, agy = self.run_helper(bin_name='my bin')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(' ', agy)
        self.assertEqual(json.loads(sets[0])[0]['command'], agy)

    def test_help_is_short_and_does_not_read_the_script(self):
        proc, sets, _ = self.run_helper('--help')
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(sets, [])
        self.assertNotIn('pipefail', proc.stdout)
        self.assertIn('--dry-run', proc.stdout)

    def test_unreadable_setting_is_left_alone(self):
        for bad in ('{not json', '{"id":"x"}', '["just a string"]'):
            proc, sets, _ = self.run_helper(agents=bad)
            self.assertNotEqual(proc.returncode, 0, bad)
            self.assertEqual(sets, [], bad)
            self.assertIn('nothing was changed', proc.stderr)

    def test_stops_without_agy(self):
        proc, sets, _ = self.run_helper(agy=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(sets, [])
        self.assertIn('not installed', proc.stderr)

    def test_stops_when_agy_has_no_acp(self):
        proc, sets, _ = self.run_helper(TEST_AGY_NO_ACP='1')
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(sets, [])

    def test_stops_when_bb_cannot_be_read_or_written(self):
        proc, sets, _ = self.run_helper(TEST_FAIL_READ='1')
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(sets, [])
        proc, _, _ = self.run_helper(TEST_FAIL_SET='1')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('refused', proc.stderr)

    def test_no_models_yet_explains_the_sign_in(self):
        proc, sets, _ = self.run_helper(TEST_NO_MODELS='1')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(sets), 1)
        self.assertIn('agy acp --login', proc.stdout)

    def test_unknown_option_stops(self):
        proc, sets, _ = self.run_helper('--yes')
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(sets, [])


if __name__ == '__main__':
    unittest.main()
