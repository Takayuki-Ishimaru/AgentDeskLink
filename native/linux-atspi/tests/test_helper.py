#!/usr/bin/python3
"""Integration tests: the real Linux AT-SPI helper against the GTK3 fixture.

Run inside a headless accessibility desktop (Xvfb + private a11y bus), for example:
  native/linux-atspi/tests/run-xvfb.sh python3 -m unittest -v native/linux-atspi/tests/test_helper.py
"""
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'adl-linux-atspi-helper.py')
FIXTURE = os.path.join(HERE, '..', 'fixture', 'fixture.py')
# The helper's shebang is /usr/bin/python3 (the interpreter that owns python3-gi); the fixture runs under the same binary so /proc/<pid>/exe matches.
PYTHON = os.path.realpath('/usr/bin/python3') if os.path.exists('/usr/bin/python3') else os.path.realpath(sys.executable)
APP = 'adl-fixture-' + str(os.getpid())


class Helper:
    def __init__(self, *flags, env=None, app_path=PYTHON, app_id=APP):
        self.process = subprocess.Popen([PYTHON, HELPER, '--app-id', app_id, '--app-path', app_path, *flags], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env if env is not None else os.environ.copy())
        self.counter = 0

    def raw(self, line, timeout=10.0):
        self.process.stdin.write(line.encode('utf-8') + b'\n')
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        buffer = b''
        while b'\n' not in buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('helper reply timed out: ' + line[:80])
            ready, _, _ = select.select([self.process.stdout], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise EOFError('helper closed stdout; stderr=' + self.process.stderr.read().decode('utf-8', 'replace'))
            buffer += chunk
        return json.loads(buffer.split(b'\n', 1)[0].decode('utf-8'))

    def call(self, op, **fields):
        self.counter += 1
        request_id = 'r%d' % self.counter
        reply = self.raw(json.dumps({'op': op, 'request_id': request_id, **fields}))
        assert reply['request_id'] == request_id, reply
        return reply

    def ok(self, op, **fields):
        reply = self.call(op, **fields)
        assert reply['ok'] is True, reply
        return reply['result']

    def error(self, op, **fields):
        reply = self.call(op, **fields)
        assert reply['ok'] is False, reply
        return reply

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:
            self.process.kill()
        self.process.stdout.close()
        self.process.stderr.close()


def by(elements, role=None, name=None, name_prefix=None):
    for element in elements:
        if role is not None and element['role'] != role:
            continue
        if name is not None and element.get('name') != name:
            continue
        if name_prefix is not None and not element.get('name', '').startswith(name_prefix):
            continue
        return element
    raise AssertionError('no element role=%r name=%r in %s' % (role, name or name_prefix, [(e['role'], e.get('name')) for e in elements]))


class FixtureTest(unittest.TestCase):
    fixture = None
    control = None

    @classmethod
    def setUpClass(cls):
        cls.control = tempfile.mkdtemp(prefix='adl-fixture-ctl-')
        env = dict(os.environ, ADL_FIXTURE_CONTROL=cls.control, ADL_FIXTURE_APP_NAME=APP)
        cls.fixture = subprocess.Popen([PYTHON, FIXTURE], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        helper = Helper('--allow-all')
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if cls.fixture.poll() is not None:
                    raise RuntimeError('fixture exited: ' + cls.fixture.stderr.read().decode('utf-8', 'replace'))
                if helper.ok('discover')['targets']:
                    return
                time.sleep(0.3)
            raise RuntimeError('fixture never appeared on the accessibility bus')
        finally:
            helper.close()

    @classmethod
    def tearDownClass(cls):
        if cls.fixture and cls.fixture.poll() is None:
            cls.fixture.kill()
            cls.fixture.wait()
        if cls.fixture:
            cls.fixture.stderr.close()
        shutil.rmtree(cls.control, ignore_errors=True)

    def command(self, text):
        with open(os.path.join(self.control, '%f' % time.time()), 'w', encoding='utf-8') as handle:
            handle.write(text)
        time.sleep(0.7)

    def helper(self, *flags, **kwargs):
        helper = Helper(*flags, **kwargs)
        self.addCleanup(helper.close)
        return helper

    def session(self, helper):
        targets = helper.ok('discover')['targets']
        target = next(t for t in targets if t['label'] == 'ADL Fixture')
        session_id = helper.ok('open', target_id=target['target_id'], mode='background_semantic')['session_id']
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        return target['target_id'], session_id, snapshot

    def test_01_discover_open_snapshot(self):
        helper = self.helper('--allow-all')
        discovered = helper.ok('discover')
        self.assertEqual(discovered['protocol_version'], 2)
        self.assertTrue(discovered['mutations_enabled'])
        self.assertEqual(discovered['focus_control'], 'probe_guarded_semantic')
        self.assertFalse(discovered['visual_capture'])
        target = next(t for t in discovered['targets'] if t['label'] == 'ADL Fixture')
        self.assertRegex(target['target_id'], r'^t_[0-9a-f]{24}$')
        self.assertEqual(target['application_id'], APP)
        self.assertEqual(target['window']['bounds']['coordinate_space'], 'desktop_physical_pixels')
        self.assertGreater(target['window']['bounds']['width'], 0)
        self.assertFalse(target['window']['minimized'])
        self.assertEqual(helper.ok('discover')['targets'][0]['target_id'], target['target_id'], 'target ids stay stable while the window lives')
        target_id, session_id, snapshot = self.session(helper)
        self.assertEqual(snapshot['revision'], 1)
        self.assertFalse(snapshot['truncated'])
        elements = snapshot['elements']
        self.assertEqual(elements[0]['role'], 'window')
        self.assertEqual(elements[0]['name'], 'ADL Fixture')
        self.assertEqual(by(elements, role='button', name='Run')['enabled'], True)
        self.assertEqual(by(elements, role='button', name='Disabled')['enabled'], False)
        self.assertEqual(by(elements, role='checkbox', name='Enabled')['checked'], False)
        self.assertEqual(by(elements, role='textbox', name='Name')['value'], '')
        self.assertEqual(by(elements, role='text', name='Serial')['value'], 'readonly-value')
        self.assertEqual(by(elements, role='combobox', name='Flavour')['value'], 'Alpha')
        self.assertEqual([e['name'] for e in elements if e['role'] == 'option'][:3], ['Alpha', 'Beta', 'Gamma'])
        self.assertEqual(by(elements, role='region', name='Log')['enabled'], True)
        self.assertTrue(any(e['role'] == 'slider' and e['name'] == 'scroll bar (vertical)' for e in elements))
        password = by(elements, role='textbox', name='Password')
        self.assertTrue(password['sensitive'])
        self.assertNotIn('value', password)
        self.assertEqual(len(set(e['id'] for e in elements)), len(elements))
        again = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(again['revision'], 1, 'an unchanged tree keeps its revision')
        self.assertEqual([e['id'] for e in again['elements']], [e['id'] for e in elements], 'element ids are stable across snapshots')
        self.assertEqual(helper.ok('close', target_id=target_id, session_id=session_id), {})
        self.assertEqual(helper.error('snapshot', target_id=target_id, session_id=session_id)['error']['code'], 'E_NO_SESSION')

    def test_02_click_updates_label_and_revision(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        before = by(snapshot['elements'], role='text', name_prefix='Status:')['name']
        button = by(snapshot['elements'], role='button', name='Run')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=button['id'], expected_revision=snapshot['revision'], action='click'), {'applied': True})
        after = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(after['revision'], snapshot['revision'] + 1)
        label = by(after['elements'], role='text', name_prefix='Status: clicked')['name']
        self.assertNotEqual(label, before)
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button['id'], expected_revision=snapshot['revision'], action='click')['error']['code'], 'E_STALE_REVISION')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(after['elements'], role='textbox', name='Name')['id'], expected_revision=after['revision'], action='click')['error']['code'], 'E_UNSUPPORTED_ACTION')

    def test_03_fill_readback(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        field = by(snapshot['elements'], role='textbox', name='Name')
        value = 'héllo ワールド %d' % time.time_ns()
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=field['id'], expected_revision=snapshot['revision'], action='fill', value=value), {'applied': True})
        after = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(by(after['elements'], role='textbox', name='Name')['value'], value)
        readonly = by(after['elements'], role='text', name='Serial')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=readonly['id'], expected_revision=after['revision'], action='fill', value='x')['error']['code'], 'E_NOT_INTERACTABLE')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=field['id'], expected_revision=after['revision'], action='fill', value='bad\x01control')['error']['code'], 'E_BAD_REQUEST')

    def test_04_check_toggle_readback(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        check = by(snapshot['elements'], role='checkbox', name='Enabled')
        desired = not check['checked']
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=check['id'], expected_revision=snapshot['revision'], action='check', checked=desired), {'applied': True})
        after = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(by(after['elements'], role='checkbox', name='Enabled')['checked'], desired)
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=check['id'], expected_revision=after['revision'], action='check', checked=desired), {'applied': True}, 'already in the desired state is a no-op')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=check['id'], expected_revision=after['revision'], action='check', checked=not desired), {'applied': True})
        final = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(by(final['elements'], role='checkbox', name='Enabled')['checked'], not desired)
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(final['elements'], role='button', name='Run')['id'], expected_revision=final['revision'], action='check', checked=True)['error']['code'], 'E_UNSUPPORTED_ACTION')

    def test_05_password_sensitive_and_not_fillable(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        password = by(snapshot['elements'], role='textbox', name='Password')
        reply = helper.error('act', target_id=target_id, session_id=session_id, element_id=password['id'], expected_revision=snapshot['revision'], action='fill', value='secret')
        self.assertEqual(reply['error']['code'], 'E_PRIVACY_BLOCKED')
        self.assertNotIn('may_have_executed', reply)
        after = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertNotIn('value', by(after['elements'], role='textbox', name='Password'))

    def test_06_stale_and_unknown_handles(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        button = by(snapshot['elements'], role='button', name='Run')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button['id'], expected_revision=snapshot['revision'] + 5, action='click')['error']['code'], 'E_STALE_REVISION')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button['id'], expected_revision=0, action='click')['error']['code'], 'E_STALE_REVISION')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id='e999999', expected_revision=snapshot['revision'], action='click')['error']['code'], 'E_NO_ELEMENT')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(snapshot['elements'], role='button', name='Disabled')['id'], expected_revision=snapshot['revision'], action='click')['error']['code'], 'E_POLICY_DENIED')
        self.assertEqual(helper.error('snapshot', target_id='t_000000000000000000000000', session_id=session_id)['error']['code'], 'E_TARGET_MISMATCH')
        self.assertEqual(helper.error('open', target_id='t_000000000000000000000000', mode='background_semantic')['error']['code'], 'E_NO_TARGET')

    def test_07_controls_file_allowlist(self):
        # Not inside the fixture control directory: the fixture consumes every file written there as a command.
        directory = tempfile.mkdtemp(prefix='adl-controls-')
        self.addCleanup(shutil.rmtree, directory, True)
        controls = os.path.join(directory, 'controls.json')
        with open(controls, 'w', encoding='utf-8') as handle:
            json.dump({'FixtureButton': {'role': 'button', 'allowed': ['click']}, 'FixtureCheck': {'role': 'textbox', 'allowed': ['check']}, 'FixtureDelete': {'role': 'push button', 'allowed': ['fill']}}, handle)
        helper = self.helper('--controls-file', controls)
        self.assertTrue(helper.ok('discover')['mutations_enabled'])
        target_id, session_id, snapshot = self.session(helper)
        elements, revision = snapshot['elements'], snapshot['revision']
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='button', name='Run')['id'], expected_revision=revision, action='click'), {'applied': True})
        snapshot = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        elements, revision = snapshot['elements'], snapshot['revision']
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='checkbox', name='Enabled')['id'], expected_revision=revision, action='check', checked=True)['error']['code'], 'E_POLICY_DENIED', 'role mismatch')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='button', name='Delete all')['id'], expected_revision=revision, action='click')['error']['code'], 'E_POLICY_DENIED', 'action not allowed')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='textbox', name='Name')['id'], expected_revision=revision, action='fill', value='x')['error']['code'], 'E_POLICY_DENIED', 'not listed')

    def test_08_no_policy_means_observe_only(self):
        helper = self.helper()
        self.assertFalse(helper.ok('discover')['mutations_enabled'])
        target_id, session_id, snapshot = self.session(helper)
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(snapshot['elements'], role='button', name='Run')['id'], expected_revision=snapshot['revision'], action='click')['error']['code'], 'E_POLICY_DENIED')
        self.assertEqual(by(helper.ok('snapshot', target_id=target_id, session_id=session_id)['elements'], role='text', name_prefix='Status:')['name'], by(snapshot['elements'], role='text', name_prefix='Status:')['name'])

    def test_09_wrong_app_path_or_name_yields_no_targets(self):
        for kwargs in ({'app_path': '/usr/bin/env'}, {'app_id': APP + '-other'}):
            helper = self.helper('--allow-all', **kwargs)
            self.assertEqual(helper.ok('discover')['targets'], [])

    def test_10_standard_mode_refuses_consequential_and_allow_all_permits(self):
        helper = self.helper('--operation-mode', 'standard')
        self.assertTrue(helper.ok('discover')['mutations_enabled'])
        target_id, session_id, snapshot = self.session(helper)
        elements, revision = snapshot['elements'], snapshot['revision']
        reply = helper.error('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='button', name='Delete all')['id'], expected_revision=revision, action='click')
        self.assertEqual(reply['error']['code'], 'E_APPROVAL_REQUIRED')
        self.assertNotIn('may_have_executed', reply)
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='textbox', name='Password')['id'], expected_revision=revision, action='fill', value='x')['error']['code'], 'E_PRIVACY_BLOCKED')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=by(elements, role='button', name='Run')['id'], expected_revision=revision, action='click'), {'applied': True})
        self.assertNotEqual(by(helper.ok('snapshot', target_id=target_id, session_id=session_id)['elements'], role='text', name_prefix='Status:')['name'], 'Status: deleted')
        blanket = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(blanket)
        self.assertEqual(blanket.ok('act', target_id=target_id, session_id=session_id, element_id=by(snapshot['elements'], role='button', name='Delete all')['id'], expected_revision=snapshot['revision'], action='click'), {'applied': True})
        self.assertEqual(by(blanket.ok('snapshot', target_id=target_id, session_id=session_id)['elements'], role='text', name_prefix='Status:')['name'], 'Status: deleted')

    def test_10b_ask_mode_honours_only_the_parents_one_shot_approval(self):
        # Without the field ask behaves like standard; `approved:true` lets exactly that consequential action through; sensitive stays refused.
        helper = self.helper('--operation-mode', 'ask')
        self.assertTrue(helper.ok('discover')['mutations_enabled'])
        target_id, session_id, snapshot = self.session(helper)
        elements, revision = snapshot['elements'], snapshot['revision']
        delete_id, password_id, run_id = (by(elements, role='button', name='Delete all')['id'], by(elements, role='textbox', name='Password')['id'], by(elements, role='button', name='Run')['id'])
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=delete_id, expected_revision=revision, action='click')['error']['code'], 'E_APPROVAL_REQUIRED')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=password_id, expected_revision=revision, action='fill', value='x', approved=True)['error']['code'], 'E_PRIVACY_BLOCKED')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=delete_id, expected_revision=revision, action='click', approved=False)['error']['code'], 'E_BAD_REQUEST')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=delete_id, expected_revision=revision, action='click', approved='yes')['error']['code'], 'E_BAD_REQUEST')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=run_id, expected_revision=revision, action='click', approved=True), {'applied': True})
        snapshot = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertTrue(by(snapshot['elements'], role='text', name_prefix='Status:')['name'].startswith('Status: clicked'))
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=delete_id, expected_revision=snapshot['revision'], action='click', approved=True), {'applied': True})
        self.assertEqual(by(helper.ok('snapshot', target_id=target_id, session_id=session_id)['elements'], role='text', name_prefix='Status:')['name'], 'Status: deleted')
        # A standard-tier or allow-all helper never honours the field.
        for flags in (('--operation-mode', 'standard'), ('--allow-all',)):
            other = self.helper(*flags)
            target_id, session_id, snapshot = self.session(other)
            reply = other.error('act', target_id=target_id, session_id=session_id, element_id=by(snapshot['elements'], role='button', name='Run')['id'], expected_revision=snapshot['revision'], action='click', approved=True)
            self.assertEqual(reply['error']['code'], 'E_BAD_REQUEST', flags)
            self.assertNotIn('may_have_executed', reply)

    def test_11_select_and_scroll(self):
        helper = self.helper('--allow-all')
        target_id, session_id, snapshot = self.session(helper)
        elements, revision = snapshot['elements'], snapshot['revision']
        gamma = by(elements, role='option', name='Gamma')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=gamma['id'], expected_revision=revision, action='select'), {'applied': True})
        after = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual(by(after['elements'], role='combobox')['value'], 'Gamma')
        options = [e for e in after['elements'] if e['role'] == 'option' and e['name'] == 'Two']
        self.assertEqual(len(options), 0, 'list rows carry their label, not a name')
        rows = [e for e in after['elements'] if e['role'] == 'option' and e['name'] == '']
        self.assertGreaterEqual(len(rows), 3)
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=rows[1]['id'], expected_revision=after['revision'], action='select'), {'applied': True})
        selected = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        self.assertEqual([e['selected'] for e in selected['elements'] if e['role'] == 'option' and e['name'] == ''][:3], [False, True, False])
        log = by(selected['elements'], role='region', name='Log')
        bar = next(e for e in selected['elements'] if e['role'] == 'slider' and e['name'] == 'scroll bar (vertical)')
        self.assertEqual(bar['value'], '0')
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=log['id'], expected_revision=selected['revision'], action='scroll', direction='down'), {'applied': True})
        scrolled = helper.ok('snapshot', target_id=target_id, session_id=session_id)
        moved = next(e for e in scrolled['elements'] if e['id'] == bar['id'])
        self.assertGreater(float(moved['value']), 0)
        self.assertEqual(helper.ok('act', target_id=target_id, session_id=session_id, element_id=bar['id'], expected_revision=scrolled['revision'], action='scroll', direction='up'), {'applied': True})
        self.assertEqual(float(next(e for e in helper.ok('snapshot', target_id=target_id, session_id=session_id)['elements'] if e['id'] == bar['id'])['value']), 0)

    def test_12_closed_window_is_not_found(self):
        helper = self.helper('--allow-all')
        self.command('open-dialog')
        targets = helper.ok('discover')['targets']
        dialog = next(t for t in targets if t['label'] == 'ADL Dialog')
        main = next(t for t in targets if t['label'] == 'ADL Fixture')
        session_id = helper.ok('open', target_id=dialog['target_id'], mode='background_semantic')['session_id']
        snapshot = helper.ok('snapshot', target_id=dialog['target_id'], session_id=session_id)
        self.assertEqual(by(snapshot['elements'], role='button', name='Dialog OK')['enabled'], True)
        self.command('close-dialog')
        self.assertEqual(helper.error('snapshot', target_id=dialog['target_id'], session_id=session_id)['error']['code'], 'E_TARGET_NOT_FOUND')
        self.assertEqual(helper.error('open', target_id=dialog['target_id'], mode='background_semantic')['error']['code'], 'E_NO_TARGET')
        self.assertEqual([t['target_id'] for t in helper.ok('discover')['targets']], [main['target_id']])
        self.command('open-dialog')
        reopened = next(t for t in helper.ok('discover')['targets'] if t['label'] == 'ADL Dialog')
        self.assertNotEqual(reopened['target_id'], dialog['target_id'], 'a recreated window never inherits the old target id')
        self.command('close-dialog')

    def test_13_protocol_errors(self):
        helper = self.helper('--allow-all')
        self.assertEqual(helper.error('capture', target_id='t_x', session_id='s_x')['error']['code'], 'E_UNSUPPORTED_ACTION')
        self.assertEqual(helper.error('application', action='status')['error']['code'], 'E_UNSUPPORTED_ACTION')
        self.assertEqual(helper.error('discover', extra=1)['error']['code'], 'E_BAD_REQUEST')
        bad = helper.raw('{not json')
        self.assertEqual((bad['ok'], bad['error']['code']), (False, 'E_BAD_REQUEST'))
        self.assertEqual(helper.raw('{"op":"discover"}')['error']['code'], 'E_BAD_REQUEST')
        targets = helper.ok('discover')['targets']
        self.assertEqual(helper.error('open', target_id=targets[0]['target_id'], mode='strict_isolated')['error']['code'], 'E_INTERFERENCE_RISK')
        self.assertEqual(helper.error('open', target_id=targets[0]['target_id'], mode='interactive_desktop')['error']['code'], 'E_UNSUPPORTED_ACTION')
        target_id, session_id, snapshot = self.session(helper)
        button = by(snapshot['elements'], role='button', name='Run')['id']
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button, expected_revision=snapshot['revision'], action='click', value='x')['error']['code'], 'E_BAD_REQUEST')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button, expected_revision=snapshot['revision'], action='press')['error']['code'], 'E_UNSUPPORTED_ACTION')
        self.assertEqual(helper.error('act', target_id=target_id, session_id=session_id, element_id=button, expected_revision='1', action='click')['error']['code'], 'E_BAD_REQUEST')

    def test_14_missing_accessibility_bus_is_reported(self):
        env = {k: v for k, v in os.environ.items() if k not in ('DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY')}
        env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/nonexistent/adl-no-bus'
        helper = self.helper('--allow-all', env=env)
        reply = helper.error('discover')
        self.assertEqual(reply['error']['code'], 'E_ATSPI_UNAVAILABLE')
        self.assertIn('python3-gi', reply['error']['message'])
        self.assertEqual(helper.error('discover')['error']['code'], 'E_ATSPI_UNAVAILABLE', 'the helper keeps answering instead of crashing')

    def test_15_usage_errors_exit_2(self):
        for args in ([], ['--app-id', APP], ['--app-id', APP, '--app-path', 'relative'], ['--app-id', APP, '--app-path', PYTHON, '--bogus'], ['--app-id', APP, '--app-path', PYTHON, '--operation-mode', 'all']):
            result = subprocess.run([PYTHON, HELPER, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 2, args)
            self.assertIn(b'usage:', result.stderr)
        released = subprocess.run([PYTHON, HELPER, '--release-input'], stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        self.assertEqual((released.returncode, json.loads(released.stdout)), (0, {'released_input': True}))


def wait_for(predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


class WaylandDisplayMissingTest(unittest.TestCase):
    """A helper in a Wayland session whose DISPLAY names a dead X server: display_ids stays empty and the protocol keeps working."""

    @classmethod
    def setUpClass(cls):
        cls.control = tempfile.mkdtemp(prefix='adl-wldead-')
        env = dict(os.environ, ADL_FIXTURE_CONTROL=cls.control, ADL_FIXTURE_APP_NAME=APP)
        cls.fixture = subprocess.Popen([PYTHON, FIXTURE], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.kill()
        cls.fixture.wait()
        cls.fixture.stderr.close()
        shutil.rmtree(cls.control, ignore_errors=True)

    def test_wayland_with_unreachable_display_yields_empty_display_ids(self):
        helper = Helper('--allow-all', env=dict(os.environ, WAYLAND_DISPLAY='wl-none', DISPLAY=':987'))
        self.addCleanup(helper.close)
        self.assertTrue(wait_for(lambda: any(t['label'] == 'ADL Fixture' for t in helper.ok('discover')['targets'])), 'the fixture never appeared on the accessibility bus')
        target = next(t for t in helper.ok('discover')['targets'] if t['label'] == 'ADL Fixture')
        self.assertEqual(target['window']['display_ids'], [])
        session_id = helper.ok('open', target_id=target['target_id'], mode='background_semantic')['session_id']
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertTrue(any(element['role'] == 'button' and element['name'] == 'Run' for element in snapshot['elements']))


if __name__ == '__main__':
    unittest.main()
