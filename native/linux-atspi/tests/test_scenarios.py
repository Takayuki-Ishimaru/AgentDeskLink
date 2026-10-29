#!/usr/bin/python3
"""Environment scenarios for the Linux AT-SPI helper: real window manager, GTK4, Qt, Wayland and large trees.

Each scenario skips cleanly when its toolkit, compositor or window manager is absent. Run inside the headless desktop:
  ADL_WM=openbox native/linux-atspi/tests/run-xvfb.sh python3 -m unittest -v native/linux-atspi/tests/test_scenarios.py
Without ADL_WM the window-manager scenario is skipped. ADL_QT_PYTHON may name a Python with PySide6/PyQt5 (default /usr/bin/python3).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_helper import FIXTURE, HELPER, PYTHON, Helper, by  # noqa: E402

FIXTURES = os.path.dirname(FIXTURE)


def wait_for(predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def python_can_import(python, statement):
    return subprocess.run([python, '-c', statement], capture_output=True, timeout=30).returncode == 0


def a11y_bus_address():
    """The accessibility bus address from org.a11y.Bus on the session bus, or None."""
    try:
        from gi.repository import Gio, GLib
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, GLib.VariantType('(s)'),
                              Gio.DBusCallFlags.NONE, 5000, None)
        return reply.unpack()[0] or None
    except Exception:
        return None


def set_root_string(display, name, value):
    """Set (or with value None delete) a STRING property on the X root window through libX11; False when X is unreachable."""
    import ctypes
    try:
        x11 = ctypes.CDLL('libX11.so.6')
    except OSError:
        return False
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    x11.XDeleteProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    handle = x11.XOpenDisplay(display.encode())
    if not handle:
        return False
    try:
        root, atom = x11.XDefaultRootWindow(handle), x11.XInternAtom(handle, name.encode(), 0)
        if value is None:
            x11.XDeleteProperty(handle, root, atom)
        else:
            data = value.encode()
            x11.XChangeProperty(handle, root, atom, x11.XInternAtom(handle, b'STRING', 0), 8, 0, data, len(data))  # 0 = PropModeReplace
        x11.XSync(handle, 0)
        return True
    finally:
        x11.XCloseDisplay(handle)


class ScenarioBase(unittest.TestCase):
    """One fixture process per class; subclasses set script, label and optionally python/env/prepare()."""
    script = FIXTURE
    label = 'ADL Fixture'
    python = PYTHON
    env = {}
    helper_env = None  # environment of the helper process; display_ids derives from its DISPLAY / WAYLAND_DISPLAY
    startup_s = 20.0

    @classmethod
    def unavailable(cls):
        return None

    @classmethod
    def setUpClass(cls):
        reason = cls.unavailable()
        if reason:
            raise unittest.SkipTest(reason)
        cls.cleanups = []
        cls.control = tempfile.mkdtemp(prefix='adl-scenario-ctl-')
        cls.app = 'adl-%s-%d' % (cls.__name__.lower(), os.getpid())
        env = dict(os.environ, ADL_FIXTURE_CONTROL=cls.control, ADL_FIXTURE_APP_NAME=cls.app, **cls.env)
        try:
            cls.extra_env(env)
        except unittest.SkipTest:
            cls.tearDownClass()
            raise
        cls.fixture = subprocess.Popen([cls.python, cls.script], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        helper = Helper('--allow-all', app_id=cls.app, app_path=os.path.realpath(cls.python), env=cls.helper_env)
        try:
            ready = wait_for(lambda: cls.fixture.poll() is None and any(t['label'] == cls.label for t in helper.ok('discover')['targets']), cls.startup_s)
        finally:
            helper.close()
        if not ready:
            error = cls.fixture.stderr.read().decode('utf-8', 'replace')[-300:] if cls.fixture.poll() is not None else ''
            cls.tearDownClass()
            raise unittest.SkipTest('%s never appeared on the accessibility bus (toolkit not accessible here) %s' % (cls.label, error))

    @classmethod
    def extra_env(cls, env):
        pass

    @classmethod
    def tearDownClass(cls):
        fixture = getattr(cls, 'fixture', None)
        if fixture is not None:
            if fixture.poll() is None:
                fixture.kill()
                fixture.wait()
            fixture.stderr.close()
        for cleanup in reversed(getattr(cls, 'cleanups', [])):
            cleanup()
        shutil.rmtree(getattr(cls, 'control', ''), ignore_errors=True)

    def command(self, text):
        with open(os.path.join(self.control, '%f' % time.time()), 'w', encoding='utf-8') as handle:
            handle.write(text)

    def helper(self, *flags):
        helper = Helper(*(flags or ('--allow-all',)), app_id=self.app, app_path=os.path.realpath(self.python), env=self.helper_env)
        self.addCleanup(helper.close)
        return helper

    def session(self, helper):
        target = next(t for t in helper.ok('discover')['targets'] if t['label'] == self.label)
        session_id = helper.ok('open', target_id=target['target_id'], mode='background_semantic')['session_id']
        return target, session_id, helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)

    def eventually_status(self, helper, target, session_id, text):
        """Newer toolkits (GTK 4, Qt) run the click handler on a later main-loop turn: poll until the status label shows the effect."""
        latest = []

        def shown():
            latest[:] = [helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)]
            return by(latest[0]['elements'], role='text', name_prefix='Status:')['name'] == text

        self.assertTrue(wait_for(shown, 5.0), 'status label never showed %r' % text)
        return latest[0]

    def act(self, helper, target, session_id, snapshot, role, name, **fields):
        return helper.call('act', target_id=target['target_id'], session_id=session_id, element_id=by(snapshot['elements'], role=role, name=name)['id'],
                           expected_revision=snapshot['revision'], **fields)


def window_states(app):
    """{window title: set of AT-SPI state nicks} read directly from the bus, independent of the helper."""
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    desktop = Atspi.get_desktop(0)
    found = {}
    for index in range(desktop.get_child_count()):
        application = desktop.get_child_at_index(index)
        if application is not None and application.get_name() == app:
            for child in range(application.get_child_count()):
                window = application.get_child_at_index(child)
                found[window.get_name()] = set(state.value_nick for state in window.get_state_set().get_states())
    return found


class RealWindowManagerTest(ScenarioBase):
    @classmethod
    def unavailable(cls):
        wm = os.environ.get('ADL_WM')
        if not wm:
            return 'no window manager: run through run-xvfb.sh with ADL_WM=openbox'
        return None if shutil.which(wm) else '%s is not installed' % wm

    def setUp(self):
        self.command('close-other')
        self.command('activate-main')
        self.assertTrue(wait_for(lambda: 'active' in window_states(self.app).get('ADL Fixture', ())), 'the window manager should activate the fixture window')

    def test_focus_probe_sees_active_window_state(self):
        states = window_states(self.app)
        self.assertIn('active', states['ADL Fixture'])
        self.command('activate-other')
        self.assertTrue(wait_for(lambda: 'active' in window_states(self.app).get('ADL Other', ())))
        self.assertNotIn('active', window_states(self.app)['ADL Fixture'])

    def test_semantic_click_does_not_raise_or_focus_windows(self):
        self.command('activate-other')
        self.assertTrue(wait_for(lambda: 'active' in window_states(self.app).get('ADL Other', ())))
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})
        fill = self.act(helper, target, session_id, helper.ok('snapshot', target_id=target['target_id'], session_id=session_id), 'textbox', 'Name', action='fill', value='background')
        self.assertEqual(fill.get('result'), {'applied': True})
        states = window_states(self.app)
        self.assertIn('active', states['ADL Other'], 'the semantic click and fill must leave the other window active')
        self.assertNotIn('active', states['ADL Fixture'])
        self.assertIn('Status: clicked', by(helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)['elements'], role='text', name_prefix='Status:')['name'])

    def test_click_without_focus_change_is_applied(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})

    def test_other_client_taking_window_focus_during_click_is_reported(self):
        for _ in range(3):
            self.command('activate-main')
            self.assertTrue(wait_for(lambda: 'active' in window_states(self.app).get('ADL Fixture', ())))
            helper = self.helper()
            target, session_id, snapshot = self.session(helper)
            reply = self.act(helper, target, session_id, snapshot, 'button', 'Steal window focus', action='click')
            self.assertFalse(reply['ok'], reply)
            self.assertEqual(reply['error']['code'], 'E_FOCUS_CHANGED')
            self.assertIs(reply['may_have_executed'], True)
            self.assertEqual(helper.error('snapshot', target_id=target['target_id'], session_id=session_id)['error']['code'], 'E_NO_SESSION', 'the session is dropped')

    def test_focus_moving_inside_the_window_is_reported(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        reply = self.act(helper, target, session_id, snapshot, 'button', 'Move focus', action='click')
        self.assertEqual((reply['ok'], reply['error']['code'], reply['may_have_executed']), (False, 'E_FOCUS_CHANGED', True))


class Gtk4Test(ScenarioBase):
    script = os.path.join(FIXTURES, 'fixture_gtk4.py')
    label = 'ADL GTK4 Fixture'
    env = {'GTK_A11Y': 'atspi'}

    @classmethod
    def unavailable(cls):
        return None if python_can_import(PYTHON, "import gi; gi.require_version('Gtk', '4.0')") else 'GTK 4 typelib (gir1.2-gtk-4.0) is not installed'

    def test_discover_snapshot_and_actions(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        self.assertGreater(target['window']['bounds']['width'], 0)
        elements = snapshot['elements']
        for role, name in (('button', 'Run'), ('textbox', 'Name'), ('checkbox', 'Enabled')):
            self.assertTrue(by(elements, role=role, name=name)['enabled'], (role, name))
        password = by(elements, role='textbox', name='Password')
        self.assertTrue(password['sensitive'])
        self.assertNotIn('value', password)
        # GTK 4 never reports STATE_ENABLED, only SENSITIVE: a disabled widget must still be disabled, an enabled one enabled.
        self.assertFalse(by(elements, role='button', name='Disabled')['enabled'])
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Disabled', action='click')['error']['code'], 'E_POLICY_DENIED')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})
        snapshot = self.eventually_status(helper, target, session_id, 'Status: clicked 1')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'textbox', 'Name', action='fill', value='gtk4 ワールド').get('result'), {'applied': True})
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertEqual(by(snapshot['elements'], role='textbox', name='Name')['value'], 'gtk4 ワールド')
        # GTK 4.14 check buttons advertise no AT-SPI action at all: the helper must say so instead of guessing (a newer GTK may add one).
        reply = self.act(helper, target, session_id, snapshot, 'checkbox', 'Enabled', action='check', checked=True)
        if reply['ok']:
            self.assertTrue(wait_for(lambda: by(helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)['elements'], role='checkbox', name='Enabled')['checked']))
        else:
            self.assertEqual(reply['error']['code'], 'E_PATTERN_UNSUPPORTED')
            self.assertNotIn('may_have_executed', reply)
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'textbox', 'Password', action='fill', value='x')['error']['code'], 'E_PRIVACY_BLOCKED')


class QtTest(ScenarioBase):
    script = os.path.join(FIXTURES, 'fixture_qt.py')
    label = 'ADL Qt Fixture'
    python = os.environ.get('ADL_QT_PYTHON', PYTHON)
    env = {'QT_LINUX_ACCESSIBILITY_ALWAYS_ON': '1', 'QT_ACCESSIBILITY': '1'}
    startup_s = 12.0

    @classmethod
    def unavailable(cls):
        return None if python_can_import(cls.python, 'from PyQt5 import QtWidgets') or python_can_import(cls.python, 'from PySide6 import QtWidgets') else 'neither PyQt5 nor PySide6 is installed'

    @classmethod
    def extra_env(cls, env):
        runtime = tempfile.mkdtemp(prefix='adl-qt-run-')
        os.chmod(runtime, 0o700)
        cls.cleanups.append(lambda: shutil.rmtree(runtime, ignore_errors=True))
        env['XDG_RUNTIME_DIR'] = runtime
        # Qt 5.15 connects to the accessibility bus asynchronously (org.a11y.Bus.GetAddress) but registers with the registry at once,
        # so the registration fails with "Disconnected" unless the X root window already carries the bus address (AT_SPI_BUS,
        # STRING), which this test desktop's at-spi-bus-launcher does not set. Set it for this class only, as a desktop session does.
        address = a11y_bus_address()
        if not address or not set_root_string(os.environ.get('DISPLAY', ''), 'AT_SPI_BUS', address):
            raise unittest.SkipTest('cannot publish AT_SPI_BUS on the X root window')
        cls.cleanups.append(lambda: set_root_string(os.environ.get('DISPLAY', ''), 'AT_SPI_BUS', None))

    def test_discover_snapshot_and_actions(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        elements = snapshot['elements']
        self.assertEqual(elements[0]['role'], 'window', 'the Qt top-level (AT-SPI role filler) is the window element')
        self.assertTrue(by(elements, role='button', name='Run')['enabled'])
        self.assertTrue(by(elements, role='textbox', name='Password')['sensitive'])
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})
        snapshot = self.eventually_status(helper, target, session_id, 'Status: clicked 1')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'textbox', 'Name', action='fill', value='qt')['result'], {'applied': True})
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertEqual(by(snapshot['elements'], role='textbox', name='Name')['value'], 'qt')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'checkbox', 'Enabled', action='check', checked=True)['result'], {'applied': True})


class WaylandTest(ScenarioBase):
    """GTK3 on a headless Weston compositor: AT-SPI reports window-relative extents, so bounds are size only and display_ids is empty."""

    @classmethod
    def unavailable(cls):
        return None if shutil.which('weston') else 'weston is not installed'

    @classmethod
    def extra_env(cls, env):
        runtime = tempfile.mkdtemp(prefix='adl-wl-run-')
        os.chmod(runtime, 0o700)
        socket = 'wl-adl-%d' % os.getpid()
        compositor = subprocess.Popen(['weston', '--backend=headless', '--socket=' + socket, '--width=1280', '--height=800', '--idle-time=0'],
                                      env=dict(os.environ, XDG_RUNTIME_DIR=runtime), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def stop():
            compositor.kill()
            compositor.wait()
            shutil.rmtree(runtime, ignore_errors=True)

        cls.cleanups.append(stop)
        if not wait_for(lambda: os.path.exists(os.path.join(runtime, socket)), 10.0):
            stop()
            cls.cleanups.pop()
            raise unittest.SkipTest('headless weston did not start')
        env.update({'XDG_RUNTIME_DIR': runtime, 'WAYLAND_DISPLAY': socket, 'GDK_BACKEND': 'wayland'})
        cls.helper_env = dict(os.environ, XDG_RUNTIME_DIR=runtime, WAYLAND_DISPLAY=socket, DISPLAY=os.environ['DISPLAY'])  # live Xvfb DISPLAY + Wayland: a native Wayland client still yields empty display_ids

    def test_geometry_is_size_only_and_actions_work(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        window = target['window']
        self.assertEqual((window['bounds']['x'], window['bounds']['y']), (0, 0))
        self.assertGreater(window['bounds']['width'], 0)
        self.assertGreater(window['bounds']['height'], 0)
        self.assertEqual(window['display_ids'], [], 'a native Wayland client has no x11 display id even while an X server runs')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})
        snapshot = self.eventually_status(helper, target, session_id, 'Status: clicked 1')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'textbox', 'Name', action='fill', value='wayland')['result'], {'applied': True})
        snapshot = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'checkbox', 'Enabled', action='check', checked=True)['result'], {'applied': True})


class XWaylandTest(ScenarioBase):
    """GTK3 forced to X11 on Weston's XWayland: with WAYLAND_DISPLAY and DISPLAY both set the helper finds the client window by _NET_WM_PID and reports the X display."""

    @classmethod
    def unavailable(cls):
        return None if shutil.which('weston') and shutil.which('Xwayland') else 'weston or Xwayland is not installed'

    @classmethod
    def extra_env(cls, env):
        runtime = tempfile.mkdtemp(prefix='adl-xwl-run-')
        os.chmod(runtime, 0o700)
        socket = 'wl-adl-%d' % os.getpid()
        before = set(os.listdir('/tmp/.X11-unix')) if os.path.isdir('/tmp/.X11-unix') else set()
        compositor = subprocess.Popen(['weston', '--backend=headless', '--xwayland', '--socket=' + socket,
                                       '--width=1280', '--height=800', '--idle-time=0', '--log=' + os.path.join(runtime, 'weston.log')],
                                      env=dict(os.environ, XDG_RUNTIME_DIR=runtime), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def stop():
            compositor.kill()
            compositor.wait()
            shutil.rmtree(runtime, ignore_errors=True)

        cls.cleanups.append(stop)
        if not wait_for(lambda: os.path.exists(os.path.join(runtime, socket)), 10.0):
            stop()
            cls.cleanups.pop()
            raise unittest.SkipTest('headless weston did not start')

        def x_display():
            # weston's xwayland module listens lazily: a socket that did not exist before, or the log line, names the number.
            for name in sorted(set(os.listdir('/tmp/.X11-unix')) - before):
                if name.startswith('X') and name[1:].isdigit():
                    return int(name[1:])
            try:
                with open(os.path.join(runtime, 'weston.log'), 'r', encoding='utf-8', errors='replace') as handle:
                    for line in handle:
                        marker = 'xserver listening on display :'
                        if marker in line:
                            return int(line.split(marker)[1].strip())
            except OSError:
                pass
            return None

        number = x_display() if wait_for(lambda: x_display() is not None, 10.0) else None
        if number is None:
            stop()
            cls.cleanups.pop()
            raise unittest.SkipTest('weston offered no XWayland display')
        env.update({'XDG_RUNTIME_DIR': runtime, 'GDK_BACKEND': 'x11', 'DISPLAY': ':%d' % number})
        env.pop('WAYLAND_DISPLAY', None)  # the fixture is a pure X client of XWayland
        cls.helper_env = dict(os.environ, XDG_RUNTIME_DIR=runtime, WAYLAND_DISPLAY=socket, DISPLAY=':%d' % number)

    def test_xwayland_client_reports_its_x_display_and_actions_work(self):
        helper = self.helper()
        target, session_id, snapshot = self.session(helper)
        self.assertEqual(target['window']['display_ids'], ['x11:' + self.helper_env['DISPLAY']],
                         'an X client of XWayland is reported with its X display')
        self.assertEqual(self.act(helper, target, session_id, snapshot, 'button', 'Run', action='click').get('result'), {'applied': True})
        snapshot = self.eventually_status(helper, target, session_id, 'Status: clicked 1')
        snapshot = self.act(helper, target, session_id, snapshot, 'textbox', 'Name', action='fill', value='xwayland')
        self.assertEqual(snapshot.get('result'), {'applied': True})


class LargeTreeTest(ScenarioBase):
    script = os.path.join(FIXTURES, 'fixture_big.py')
    label = 'ADL Big Fixture'
    env = {'ADL_FIXTURE_BUTTONS': '1500'}
    startup_s = 40.0

    def test_snapshot_is_truncated_within_bounds(self):
        helper = self.helper()
        target = next(t for t in helper.ok('discover')['targets'] if t['label'] == self.label)
        session_id = helper.ok('open', target_id=target['target_id'], mode='background_semantic')['session_id']
        started = time.monotonic()
        raw = helper.raw(json.dumps({'op': 'snapshot', 'request_id': 'big', 'target_id': target['target_id'], 'session_id': session_id}), timeout=15)
        elapsed = time.monotonic() - started
        snapshot = raw['result']
        self.assertTrue(snapshot['truncated'])
        self.assertLessEqual(len(snapshot['elements']), 1000)
        self.assertGreater(len(snapshot['elements']), 100)
        self.assertLess(elapsed, 3.5 + 2.0, 'the 3.5 s walk deadline plus reply encoding')
        self.assertLess(len(json.dumps(raw, ensure_ascii=False, separators=(',', ':')).encode('utf-8')), 65536)
        first = next(e for e in snapshot['elements'] if e['role'] == 'button')
        reply = helper.call('act', target_id=target['target_id'], session_id=session_id, element_id=first['id'], expected_revision=snapshot['revision'], action='click')
        self.assertEqual(reply.get('result'), {'applied': True}, 'elements inside the bound stay actionable')
        again = helper.ok('snapshot', target_id=target['target_id'], session_id=session_id)
        self.assertTrue(again['truncated'])
        self.assertEqual(by(again['elements'], role='text', name_prefix='Status:')['name'], 'Status: clicked ' + first['name'].split()[-1])


if __name__ == '__main__':
    unittest.main()
