"""Unit tests for Linux all-app discovery (--all-apps) in adl-linux-atspi-helper.py.

Runs without AT-SPI/GLib: the helper module is imported directly and Backend is
subclassed with fakes for apps/children/extents/role/has/pump, while the real
discover/matching_apps/live_target code paths execute. proc_identity and
display_ids_for are patched at module level.
"""
import importlib.util
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

HELPER_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'adl-linux-atspi-helper.py')
_spec = importlib.util.spec_from_file_location('adl_linux_atspi_helper', HELPER_PATH)
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

APP_PATH = os.path.realpath('/usr/bin/foo')
DISPLAYS = ['x11::0']


class FakeStateSet:
    def __init__(self, states):
        self._states = states

    def contains(self, state):
        return state in self._states


class FakeWindow:
    # No action/focus/editable interfaces exist on these fakes: any focus or input call from the
    # discovery path would raise AttributeError, so a green run proves none happened.
    def __init__(self, label='win', role='frame', states=(), rect=None):
        self.label = label
        self.role = role
        self.states = set(states)
        self.rect = rect if rect is not None else {'x': 0, 'y': 0, 'width': 100, 'height': 50}

    def get_name(self):
        return self.label

    def get_state_set(self):
        return FakeStateSet(self.states)


class FakeApp:
    def __init__(self, name, pid, windows):
        self._name = name
        self.pid = pid
        self.windows = list(windows)

    def get_name(self):
        return self._name

    def get_process_id(self):
        return self.pid


class FakeBackend(helper.Backend):
    """Real discover/matching_apps/live_target; only AT-SPI plumbing is faked."""

    def __init__(self, apps, app_id, app_path, all_apps=False):
        prereq = SimpleNamespace(atspi=SimpleNamespace(StateType=SimpleNamespace(DEFUNCT='defunct')))
        super().__init__(prereq, app_id, app_path, all_apps=all_apps)
        self._apps = list(apps)

    def pump(self):
        pass

    def apps(self):
        return list(self._apps)

    def children(self, node):
        return list(node.windows) if isinstance(node, FakeApp) else []

    def role_name(self, node):
        return getattr(node, 'role', '')

    def has(self, node, name):
        return name.lower() in getattr(node, 'states', set())

    def extents(self, node):
        return dict(node.rect) if getattr(node, 'rect', None) else None


def make_backend(apps, app_id='Foo', app_path=APP_PATH, all_apps=False, identities=None):
    backend = FakeBackend(apps, app_id, app_path, all_apps=all_apps)
    identities = dict(identities or {})

    def fake_proc_identity(pid):
        value = identities.get(pid)
        return tuple(value) if value is not None else None

    # Patched at module level; stopped by mock.patch.stopall() in tearDown.
    mock.patch.object(helper, 'proc_identity', side_effect=fake_proc_identity).start()
    mock.patch.object(helper, 'display_ids_for', return_value=list(DISPLAYS)).start()
    return backend, identities


class AllAppsTest(unittest.TestCase):
    def tearDown(self):
        mock.patch.stopall()

    def discover(self, backend, policy_active=False):
        return backend.discover(policy_active)

    def test_parse_all_apps_sets_all_apps_only(self):
        opts = helper.parse_args(['--app-id', 'Foo', '--app-path', '/usr/bin/foo', '--all-apps'])
        self.assertTrue(opts['all_apps'])
        self.assertFalse(opts['allow_all'])

    def test_parse_allow_all_sets_allow_all_only(self):
        opts = helper.parse_args(['--app-id', 'Foo', '--app-path', '/usr/bin/foo', '--allow-all'])
        self.assertTrue(opts['allow_all'])
        self.assertFalse(opts['all_apps'])

    def test_parse_both_flags_are_independent(self):
        opts = helper.parse_args(['--app-id', 'Foo', '--app-path', '/usr/bin/foo', '--all-apps', '--allow-all'])
        self.assertTrue(opts['all_apps'])
        self.assertTrue(opts['allow_all'])

    def test_parse_without_flags_defaults_false(self):
        opts = helper.parse_args(['--app-id', 'Foo', '--app-path', '/usr/bin/foo'])
        self.assertFalse(opts['all_apps'])
        self.assertFalse(opts['allow_all'])

    def test_restricted_requires_exact_name_and_exe(self):
        exact = FakeApp('Foo', 101, [FakeWindow('Exact')])
        wrong_exe = FakeApp('Foo', 102, [FakeWindow('WrongExe')])
        wrong_name = FakeApp('FooBar', 103, [FakeWindow('WrongName')])
        case_name = FakeApp('foo', 104, [FakeWindow('CaseName')])
        backend, identities = make_backend(
            [exact, wrong_exe, wrong_name, case_name],
            identities={101: (APP_PATH, '1000'), 102: ('/usr/bin/bar', '1001'),
                        103: (APP_PATH, '1002'), 104: (APP_PATH, '1003')})
        result = self.discover(backend)
        self.assertEqual(len(result['targets']), 1)
        self.assertEqual(result['targets'][0]['label'], 'Exact')
        self.assertEqual(backend.targets[[t['id'] for t in backend.targets.values()][0]]['pid'], 101)

    def test_broad_accepts_two_apps_different_executables_without_mutations(self):
        alpha = FakeApp('Alpha', 201, [FakeWindow('Alpha Window')])
        beta = FakeApp('Beta', 202, [FakeWindow('Beta Window')])
        backend, identities = make_backend(
            [alpha, beta], app_id='Alpha', all_apps=True,
            identities={201: ('/usr/bin/alpha', '2000'), 202: ('/usr/bin/beta', '2001')})
        policy = helper.Policy(False, None, None)
        self.assertFalse(policy.active)  # breadth must not imply mutation permission
        result = self.discover(backend, policy.active)
        self.assertFalse(result['mutations_enabled'])
        self.assertEqual(sorted(t['label'] for t in result['targets']), ['Alpha Window', 'Beta Window'])

    def test_broad_live_target_pins_path_and_start(self):
        alpha = FakeApp('Alpha', 301, [FakeWindow('Alpha Window')])
        beta = FakeApp('Beta', 302, [FakeWindow('Beta Window')])
        backend, identities = make_backend(
            [alpha, beta], app_id='Alpha', all_apps=True,
            identities={301: ('/usr/bin/alpha', '3000'), 302: ('/usr/bin/beta', '3001')})
        self.discover(backend)
        by_pid = {t['pid']: t for t in backend.targets.values()}
        self.assertEqual((by_pid[301]['path'], by_pid[301]['start']), ('/usr/bin/alpha', '3000'))
        self.assertEqual((by_pid[302]['path'], by_pid[302]['start']), ('/usr/bin/beta', '3001'))
        backend.sessions['s_alpha'] = {'id': 's_alpha', 'target_id': by_pid[301]['id']}
        # Changed executable (replaced process) retires that target and its session only.
        identities[301] = ('/usr/bin/replacement', '3000')
        with self.assertRaises(helper.HelperError) as ctx:
            backend.live_target(by_pid[301]['id'])
        self.assertEqual(ctx.exception.code, 'E_TARGET_NOT_FOUND')
        self.assertNotIn(by_pid[301]['id'], backend.targets)
        self.assertNotIn('s_alpha', backend.sessions)
        self.assertIs(backend.live_target(by_pid[302]['id']), by_pid[302])
        # Changed start time (pid reuse, same exe) retires the other target too.
        identities[302] = ('/usr/bin/beta', '9999')
        with self.assertRaises(helper.HelperError) as ctx:
            backend.live_target(by_pid[302]['id'])
        self.assertEqual(ctx.exception.code, 'E_TARGET_NOT_FOUND')
        self.assertEqual(backend.targets, {})

    def test_unknown_target_rejected(self):
        backend, _ = make_backend([], app_id='Alpha', all_apps=True)
        with self.assertRaises(helper.HelperError) as ctx:
            backend.live_target('t_missing')
        self.assertEqual(ctx.exception.code, 'E_NO_TARGET')

    def test_discovery_does_not_rebind_an_existing_session_after_exec(self):
        app = FakeApp('Alpha', 301, [FakeWindow('Alpha Window')])
        backend, identities = make_backend([app], all_apps=True, identities={301: ('/usr/bin/alpha', '3000')})
        self.discover(backend)
        previous = next(iter(backend.targets))
        backend.sessions['s_old'] = {'target_id': previous}
        identities[301] = ('/usr/bin/replacement', '3000')
        self.discover(backend)
        self.assertNotIn(previous, backend.targets)
        self.assertNotIn('s_old', backend.sessions)
        self.assertNotEqual(next(iter(backend.targets)), previous)

    def test_max_targets_cap_is_global_across_apps(self):
        apps = [FakeApp('App%d' % n, 1000 + n, [FakeWindow('App%d Window%d' % (n, w)) for w in range(15)])
                for n in range(3)]
        identities = {1000 + n: ('/usr/bin/app%d' % n, str(5000 + n)) for n in range(3)}
        backend, _ = make_backend(apps, app_id='App0', all_apps=True, identities=identities)
        result = self.discover(backend)
        self.assertEqual(len(result['targets']), helper.MAX_TARGETS)
        self.assertEqual(len(backend.targets), helper.MAX_TARGETS)
        labels = [t['label'] for t in result['targets']]
        self.assertEqual(sum(1 for label in labels if label.startswith('App0 ')), 15)
        self.assertEqual(sum(1 for label in labels if label.startswith('App1 ')), 15)
        self.assertEqual(sum(1 for label in labels if label.startswith('App2 ')), helper.MAX_TARGETS - 30)

    def test_application_id_matches_actual_app_names_in_broad_mode(self):
        alpha = FakeApp('Alpha', 401, [FakeWindow('Alpha Window')])
        beta = FakeApp('Beta', 402, [FakeWindow('Beta Window')])
        unnamed = FakeApp('', 403, [FakeWindow('Unnamed Window')])
        backend, _ = make_backend(
            [alpha, beta, unnamed], app_id='Alpha', all_apps=True,
            identities={401: ('/usr/bin/alpha', '4000'), 402: ('/usr/bin/beta', '4001'),
                        403: ('/usr/bin/gamma', '4002')})
        result = self.discover(backend)
        self.assertEqual({t['label']: t['application_id'] for t in result['targets']},
                         {'Alpha Window': 'Alpha', 'Beta Window': 'Beta', 'Unnamed Window': 'gamma'})

    def test_application_id_is_registered_app_id_in_restricted_mode(self):
        exact = FakeApp('Foo', 501, [FakeWindow('Foo Window')])
        backend, _ = make_backend([exact], app_id='Foo', identities={501: (APP_PATH, '5000')})
        result = self.discover(backend)
        self.assertEqual(result['targets'][0]['application_id'], 'Foo')

    def test_broad_application_id_truncated_to_128(self):
        long_name = 'N' * 200
        app = FakeApp(long_name, 601, [FakeWindow('Long')])
        backend, _ = make_backend([app], app_id='Foo', all_apps=True,
                                        identities={601: ('/usr/bin/long', '6000')})
        result = self.discover(backend)
        self.assertEqual(result['targets'][0]['application_id'], 'N' * 128)

    def test_discovery_performs_no_focus_or_input_operations(self):
        app = FakeApp('Alpha', 701, [FakeWindow('Alpha Window')])
        backend, _ = make_backend([app], app_id='Alpha', all_apps=True,
                                        identities={701: ('/usr/bin/alpha', '7000')})
        result = self.discover(backend)
        self.assertEqual(result['focus_control'], 'probe_guarded_semantic')
        self.assertFalse(result['visual_capture'])
        self.assertEqual(result['protocol_version'], 2)
        self.assertEqual(result['targets'][0]['window']['display_ids'], DISPLAYS)
        for node in (app, app.windows[0]):
            for forbidden in ('do_action', 'grab_focus', 'set_text_contents', 'insert_text', 'click'):
                self.assertFalse(hasattr(node, forbidden))


if __name__ == '__main__':
    unittest.main()
