"""Full installer contract tests against an isolated, synthetic BB CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parents[1] / 'install.sh'
PRO = 'navaigate-workspace@1.8.1  running\n  source: git:https://github.com/skyremote/bb-overlay.git@main'
PERSONAL = 'navaigate-skin@0.33.1  running\n  source: path:/Users/example/own-skin'
SIMPLE = 'navaigate-simple@1.0.0  running\n  source: git:https://github.com/skyremote/bb-overlay.git@main'
CONSOLE = 'navaigate-skin@0.34.0  running\n  source: git:https://github.com/skyremote/bb-overlay.git@main'
REPO = 'git:https://github.com/skyremote/bb-overlay.git@main'
FAKE_BB = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['TEST_CALLS'], 'a') as f: f.write(json.dumps(args)+'\\n')
if args == ['--version']: print(os.environ.get('TEST_VERSION','0.48.0'))
elif args == ['plugin','list']: print(os.environ.get('TEST_PLUGINS',''))
elif args[:3] == ['settings','ui','get']:
    print(json.dumps(os.environ.get('TEST_NAV','navigation/rail') if args[3]=='sidebar.navigationProvider' else os.environ.get('TEST_LIST','navaigate-workspace/rail')))
elif args == ['theme','show']: print('Active: Default (default)')
elif args[:2] == ['plugin','install'] and os.environ.get('TEST_FAIL_INSTALL') in args and os.environ.get('TEST_FAIL_INSTALL'): sys.exit(1)
elif args[:2] == ['plugin','reload'] and os.environ.get('TEST_FAIL_RELOAD') in args and os.environ.get('TEST_FAIL_RELOAD'): sys.exit(1)
elif args[:3] == ['settings','ui','set'] and os.environ.get('TEST_FAIL_SETTING') in args and os.environ.get('TEST_FAIL_SETTING'): sys.exit(1)
'''

class InstallerTest(unittest.TestCase):
    def run_installer(self,*flags,code=0,**values):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name,content in [('bb',FAKE_BB),('git','#!/bin/sh\nexit 0\n')]:
                p=root/name;p.write_text(content);p.chmod(0o755)
            log=root/'calls.jsonl'
            home=root/'home';home.mkdir()
            env=dict(os.environ,PATH=tmp+os.pathsep+os.environ['PATH'],TEST_CALLS=str(log),XDG_CONFIG_HOME=str(root/'config'),HOME=str(home),**values)
            result=subprocess.run(['bash',str(INSTALLER),*flags],env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,code,result.stdout+result.stderr)
            self.saved=sorted(str(f.relative_to(root/'config')) for f in (root/'config').rglob('*') if f.is_file())
            self.home_files=sorted(str(f.relative_to(home)) for f in home.rglob('*'))
            self.stderr=result.stderr
            return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else [],result.stdout

    def installs(self,calls):
        return [c[c.index('--plugin')+1] if '--plugin' in c else c[2] for c in calls if c[:2]==['plugin','install']]

    def test_fresh_defaults_to_the_console_on_the_simple_preset(self):
        calls,out=self.run_installer()
        self.assertEqual(self.installs(calls),['console','helper-desk','cache-clock','reflect','screen-share','navmotion-skin','onboarding'])
        self.assertIn(['settings','ui','set','sidebar.threadListProvider','navaigate-skin/rail'],calls)
        self.assertIn(['settings','ui','set','sidebar.navigationProvider','navigation/rail'],calls)
        self.assertIn(['theme','set','plugin:navaigate-skin:navaigate'],calls)
        self.assertIn(['plugin','config','navaigate-skin','set','preset','simple'],calls)
        self.assertIn(['plugin','config','bb-overlay-guide','set','edition','console'],calls)
        self.assertIn('extras/brain-selfhost-kit',out)
        self.assertNotIn('install-hook.sh',out)

    def test_fresh_pro_adds_fleet_prompt_stack_and_the_pro_extras(self):
        calls,out=self.run_installer('--edition','pro')
        installs=self.installs(calls)
        for plugin in ['console','fleet','prompt-stack','kanban','finder-links','tasks']: self.assertIn(plugin,installs)
        self.assertTrue(any('bb-plugin-project-folders' in value for value in installs))
        self.assertTrue(any('bb-plugin-agent-board' in value for value in installs))
        self.assertNotIn('simple',installs);self.assertNotIn('workspace',installs)
        self.assertIn(['plugin','config','navaigate-skin','set','preset','pro'],calls)
        self.assertIn(['settings','ui','set','sidebar.threadListProvider','navaigate-skin/rail'],calls)

    def test_fresh_pro_prints_the_hook_command_and_never_touches_claude_settings(self):
        calls,out=self.run_installer('--edition','pro')
        self.assertIn('plugins/prompt-stack/claude-plugin/install-hook.sh',out)
        self.assertIn('never touches ~/.claude/settings.json',out)
        self.assertFalse([f for f in self.home_files if f.startswith('.claude')])
        self.assertFalse(any('settings.json' in ' '.join(c) for c in calls))

    def test_existing_pro_preserves_exact_appearance(self):
        calls,out=self.run_installer(TEST_PLUGINS=PRO)
        self.assertFalse(any(c[:3]==['settings','ui','set'] or c[:2]==['theme','set'] for c in calls))
        self.assertEqual(self.installs(calls),['onboarding'])
        self.assertFalse(any('navaigate-skin' in c for c in calls))
        self.assertFalse(any(c[:2]==['plugin','disable'] for c in calls))
        self.assertIn(['plugin','config','bb-overlay-guide','set','edition','pro'],calls)
        self.assertEqual(out.count('--console'),1)

    def test_personal_pro_is_not_replaced_by_public_workspace(self):
        calls,_=self.run_installer(TEST_PLUGINS=PERSONAL,TEST_LIST='navaigate-skin/rail')
        self.assertEqual(self.installs(calls),['onboarding'])
        self.assertFalse(any(c[:2]==['plugin','disable'] for c in calls))
        self.assertFalse(any(c[:3]==['settings','ui','set'] for c in calls))

    def test_disabled_helper_is_not_reenabled_or_updated(self):
        plugins=PRO+'\nhelper-desk@0.1.0  disabled\n  source: git:https://github.com/skyremote/bb-overlay.git@main'
        calls,_=self.run_installer(TEST_PLUGINS=plugins)
        self.assertNotIn(['plugin','enable','helper-desk'],calls)
        self.assertFalse(any(c[:3]==['plugin','update','helper-desk'] for c in calls))

    def test_existing_simple_preserves_look_and_edition(self):
        calls,out=self.run_installer(TEST_PLUGINS=SIMPLE,TEST_LIST='navaigate-simple/rail')
        self.assertNotIn('workspace',self.installs(calls));self.assertNotIn('console',self.installs(calls))
        self.assertFalse(any(c[:3]==['settings','ui','set'] for c in calls))
        self.assertFalse(any(c[:2]==['plugin','disable'] for c in calls))
        self.assertFalse(any('navaigate-skin' in c for c in calls))
        self.assertIn(['plugin','config','bb-overlay-guide','set','edition','simple'],calls)
        self.assertEqual(out.count('--console'),1)

    def test_no_look_is_respected(self):
        calls,_=self.run_installer('--no-look')
        self.assertFalse(any(c[:3]==['settings','ui','set'] or c[:2]==['theme','set'] for c in calls))

    def test_dry_run_does_not_mutate(self):
        calls,out=self.run_installer('--dry-run')
        self.assertIn('navaigate-skin/rail',out)
        self.assertFalse(any(c[:2] in [['plugin','install'],['plugin','config'],['plugin','disable'],['plugin','reload']] or c[:3]==['settings','ui','set'] for c in calls))

    def test_failed_main_install_never_switches_or_starts_guide(self):
        calls,_=self.run_installer('--edition','simple',TEST_PLUGINS=PERSONAL,TEST_FAIL_INSTALL='simple',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] or c[:2]==['plugin','config'] or c[:3]==['settings','ui','set'] for c in calls))

    def test_explicit_simple_switch_disables_only_pro_core_and_never_uninstalls(self):
        calls,_=self.run_installer('--edition=simple',TEST_PLUGINS=PERSONAL+'\nagent-flow@1.0.0  running\n  source: path:/example/flow')
        self.assertIn(['plugin','disable','navaigate-skin'],calls)
        self.assertNotIn(['plugin','disable','agent-flow'],calls)
        self.assertFalse(any(c[:2]==['plugin','remove'] for c in calls))

    def test_return_to_personal_pro_does_not_add_absent_optional_plugins(self):
        plugins='navaigate-simple@1.0.0  running\n  source: git:https://github.com/skyremote/bb-overlay.git@main\nnavaigate-skin@0.33.1  disabled\n  source: path:/example/own-skin'
        calls,_=self.run_installer('--edition','pro',TEST_PLUGINS=plugins)
        self.assertEqual(self.installs(calls),['onboarding'])
        self.assertIn(['plugin','enable','navaigate-skin'],calls)
        self.assertIn(['plugin','disable','navaigate-simple'],calls)

    def test_switch_with_no_look_is_rejected_before_mutations(self):
        calls,_=self.run_installer('--edition','simple','--no-look',TEST_PLUGINS=PERSONAL,TEST_LIST='navaigate-skin/rail',code=1)
        self.assertFalse(any(c[:2] in [['plugin','disable'],['plugin','install']] for c in calls))

    def test_selected_pro_provider_wins_over_coinstalled_simple(self):
        plugins=PERSONAL+'\nnavaigate-simple@0.1.0  running\n  source: git:https://github.com/skyremote/bb-overlay.git@main'
        calls,_=self.run_installer(TEST_PLUGINS=plugins,TEST_LIST='navaigate-skin/rail')
        self.assertIn(['plugin','config','bb-overlay-guide','set','edition','pro'],calls)
        self.assertFalse(any(c[:3]==['settings','ui','set'] for c in calls))

    def test_reload_failure_keeps_pro_core_and_appearance(self):
        calls,_=self.run_installer('--edition','simple',TEST_PLUGINS=PERSONAL,TEST_LIST='navaigate-skin/rail',TEST_FAIL_RELOAD='navaigate-simple',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] or c[:3]==['settings','ui','set'] for c in calls))

    def test_appearance_failure_restores_previous_and_keeps_pro_core(self):
        calls,_=self.run_installer('--edition','simple',TEST_PLUGINS=PERSONAL,TEST_LIST='navaigate-skin/rail',TEST_FAIL_SETTING='navaigate-simple/rail',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] for c in calls))
        self.assertIn(['settings','ui','set','sidebar.threadListProvider','"navaigate-skin/rail"'],calls)
        self.assertFalse(any(c[:2]==['plugin','config'] for c in calls))

    def test_explicit_pro_keeps_selected_public_core_over_disabled_personal_core(self):
        plugins=PRO+'\nnavaigate-skin@0.33.1  disabled\n  source: path:/example/own-skin'
        calls,_=self.run_installer('--edition','pro',TEST_PLUGINS=plugins,TEST_LIST='navaigate-workspace/rail')
        self.assertNotIn(['plugin','enable','navaigate-skin'],calls)
        self.assertFalse(any(c[:3]==['settings','ui','set'] for c in calls))

    def test_no_mods_still_gets_the_console_and_guide(self):
        calls,_=self.run_installer('--no-mods')
        self.assertEqual(self.installs(calls),['console','onboarding'])

    def test_guide_configured_last_without_resetting_progress(self):
        calls,_=self.run_installer()
        config=[c for c in calls if c[:2]==['plugin','config'] and c[2]=='bb-overlay-guide']
        self.assertEqual(config,[['plugin','config','bb-overlay-guide','set','edition','console'],['plugin','config','bb-overlay-guide','set','autoStart','true']])
        self.assertGreater(calls.index(config[0]),max(i for i,c in enumerate(calls) if c[:2]==['plugin','install']))

    def test_old_bb_stops_before_any_install(self):
        calls,_=self.run_installer(TEST_VERSION='0.46.1',code=1)
        self.assertFalse(self.installs(calls))

    def test_invalid_edition_fails_before_bb_commands(self):
        calls,_=self.run_installer('--edition','unknown',code=2)
        self.assertEqual(calls,[])

    # ---- 1.12: the Console
    def test_dry_run_changes_nothing_including_the_preset(self):
        calls,out=self.run_installer('--dry-run','--edition','pro')
        mutating=[c for c in calls if c[:2] in [['plugin','install'],['plugin','config'],['plugin','disable'],['plugin','enable'],['plugin','reload'],['plugin','update']] or c[:3]==['settings','ui','set'] or c[:2]==['theme','set']]
        self.assertEqual(mutating,[])
        self.assertIn('preset pro',out);self.assertEqual(self.saved,[])

    def test_existing_console_is_updated_but_never_given_a_preset_or_a_new_look(self):
        calls,_=self.run_installer(TEST_PLUGINS=CONSOLE,TEST_LIST='navaigate-skin/rail')
        self.assertIn(['plugin','update','navaigate-skin','--yes'],calls)
        self.assertFalse(any(c[:3]==['plugin','config','navaigate-skin'] for c in calls))
        self.assertFalse(any(c[:3]==['settings','ui','set'] or c[:2]==['theme','set'] or c[:2]==['plugin','disable'] for c in calls))
        self.assertIn(['plugin','config','bb-overlay-guide','set','edition','console'],calls)

    def test_pro_flag_on_an_existing_console_adds_the_extras_without_a_preset(self):
        calls,_=self.run_installer('--edition','pro',TEST_PLUGINS=CONSOLE,TEST_LIST='navaigate-skin/rail')
        self.assertIn('fleet',self.installs(calls));self.assertIn('prompt-stack',self.installs(calls))
        self.assertFalse(any(c[:3]==['plugin','config','navaigate-skin'] for c in calls))
        self.assertFalse(any(c[:3]==['settings','ui','set'] for c in calls))

    def test_console_switch_from_simple_installs_first_then_switches_and_disables(self):
        calls,_=self.run_installer('--console',TEST_PLUGINS=SIMPLE,TEST_LIST='navaigate-simple/rail')
        i_install=min(i for i,c in enumerate(calls) if 'console' in c and c[:2]==['plugin','install'])
        i_reload=calls.index(['plugin','reload','navaigate-skin'])
        i_set=calls.index(['settings','ui','set','sidebar.threadListProvider','navaigate-skin/rail'])
        i_off=calls.index(['plugin','disable','navaigate-simple'])
        self.assertTrue(i_install<i_reload<i_set<i_off)
        self.assertIn(['plugin','config','navaigate-skin','set','preset','simple'],calls)
        self.assertFalse(any(c[:2]==['plugin','remove'] for c in calls))
        self.assertIn('bb-overlay/before-console/thread-list.json',self.saved);self.assertIn('bb-overlay/before-console/theme.txt',self.saved)

    def test_console_switch_from_pro_carries_the_pro_preset_and_keeps_the_old_core_enabled_until_then(self):
        calls,_=self.run_installer('--console',TEST_PLUGINS=PRO)
        self.assertIn(['plugin','config','navaigate-skin','set','preset','pro'],calls)
        self.assertIn(['plugin','disable','navaigate-workspace'],calls)
        self.assertFalse(any(c[:2]==['plugin','remove'] for c in calls))
        for left_out in ['fleet','prompt-stack','kanban','finder-links','tasks']: self.assertNotIn(left_out,self.installs(calls))

    def test_console_switch_from_pro_with_the_pro_flag_adds_the_pro_plugins(self):
        calls,_=self.run_installer('--console','--edition','pro',TEST_PLUGINS=PRO)
        for plugin in ['fleet','prompt-stack','kanban']: self.assertIn(plugin,self.installs(calls))

    def test_console_switch_rolls_back_when_the_appearance_fails(self):
        calls,_=self.run_installer('--console',TEST_PLUGINS=PRO,TEST_LIST='navaigate-workspace/rail',TEST_FAIL_SETTING='navaigate-skin/rail',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] for c in calls))
        self.assertIn(['settings','ui','set','sidebar.threadListProvider','"navaigate-workspace/rail"'],calls)
        self.assertFalse(any(c[:2]==['plugin','config'] for c in calls))

    def test_console_switch_stops_when_the_reload_fails(self):
        calls,_=self.run_installer('--console',TEST_PLUGINS=SIMPLE,TEST_LIST='navaigate-simple/rail',TEST_FAIL_RELOAD='navaigate-skin',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] or c[:3]==['settings','ui','set'] or c[:2]==['plugin','config'] for c in calls))

    def test_console_switch_stops_when_the_install_fails(self):
        calls,_=self.run_installer('--console',TEST_PLUGINS=SIMPLE,TEST_LIST='navaigate-simple/rail',TEST_FAIL_INSTALL='console',code=1)
        self.assertFalse(any(c[:2]==['plugin','disable'] or c[:3]==['settings','ui','set'] or c[:2]==['plugin','config'] for c in calls))

    def test_console_switch_with_no_look_is_rejected_before_any_change(self):
        calls,_=self.run_installer('--console','--no-look',TEST_PLUGINS=PRO,code=1)
        self.assertFalse(any(c[:2] in [['plugin','install'],['plugin','disable'],['plugin','config']] for c in calls))

    def test_a_navaigate_skin_from_another_source_is_left_alone(self):
        for flags in [(),('--console',),('--edition','pro')]:
            with self.subTest(flags=flags):
                calls,_=self.run_installer(*flags,TEST_PLUGINS=PERSONAL,TEST_LIST='navaigate-skin/rail')
                self.assertNotIn('console',self.installs(calls))
                self.assertFalse(any(c[:3]==['plugin','config','navaigate-skin'] for c in calls))
                self.assertFalse(any(c[:2] in [['plugin','disable'],['plugin','update']] and 'navaigate-skin' in c for c in calls))
                self.assertFalse(any(c[:3]==['settings','ui','set'] or c[:2]==['theme','set'] for c in calls))

    def test_a_disabled_console_stays_disabled_without_the_flag(self):
        calls,_=self.run_installer(TEST_PLUGINS=CONSOLE.replace('running','disabled'),TEST_LIST='navaigate-skin/rail')
        self.assertFalse(any(c[:2]==['plugin','enable'] for c in calls))
        self.assertFalse(any(c[:3]==['plugin','config','navaigate-skin'] for c in calls))

    def test_edition_without_console_still_switches_a_1_11_install(self):
        calls,_=self.run_installer('--edition','simple',TEST_PLUGINS=PRO)
        self.assertIn('simple',self.installs(calls));self.assertNotIn('console',self.installs(calls))
        self.assertIn(['plugin','disable','navaigate-workspace'],calls)

if __name__=='__main__': unittest.main()
