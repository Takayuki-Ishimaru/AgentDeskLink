#!/usr/bin/python3
"""AgentDeskLink Linux AT-SPI2 helper: JSONL protocol v2 (discover / open / snapshot / act / close).

Runtime dependencies: Python 3 standard library, python3-gi and gir1.2-atspi-2.0 (GLib + Atspi).
The helper never calls grab_focus, never generates mouse or keyboard events and never raises
windows; mutations go through advertised AT-SPI actions, EditableText, Selection and Value only.
Missing prerequisites are reported per request as E_ATSPI_UNAVAILABLE, never as a crash.
"""
import hashlib
import json
import os
import re
import secrets
import sys
import time
import unicodedata
import warnings

MAX_LINE = 65536
MAX_REPLY = 60000
MAX_TEXT = 512
MAX_FILL_BYTES = 4096
MAX_ELEMENTS = 1000
MAX_TARGETS = 32
MAX_SESSIONS = 32
WALK_DEADLINE_S = 3.5
READBACK_S = 0.4
PUBLIC_ROLES = ('button', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'listitem', 'link', 'tab', 'menuitem', 'slider', 'spinbutton')
# Qt 5 exposes a top-level QWidget as a "filler" child of the application (there is no frame accessible).
WINDOW_ROLES = ('frame', 'dialog', 'window', 'filler')
CLICK_ROLES = ('button', 'link', 'menuitem', 'tab', 'option', 'listitem', 'treeitem', 'checkbox', 'radio')
CHECK_ROLES = ('checkbox', 'radio', 'menuitem', 'button', 'switch')
SELECT_ROLES = ('option', 'listitem', 'tab', 'treeitem', 'menuitem', 'row', 'cell')
# Same vocabulary as the browser path (src/policy.ts + src/browser-approval.ts), including the Japanese terms.
CONSEQUENTIAL = re.compile(
    r"\b(?:delete|remove(?!\s+filters?\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer|confirm|cancel|order)\b"
    r"|削除|購入|注文|支払|決済|送信|登録|取消|取り消|キャンセル|振込|送金|転送|申込|申し込|解約|確定|ログイン", re.IGNORECASE)
# Port of SECRET_LABEL_PATTERN in src/privacy.ts.
SECRET = re.compile(
    r"(?:^|[^a-z0-9])(?:password|passwd|pwd|passcode|secret|token|api[ _-]*key|access[ _-]*(?:key|token)|refresh[ _-]*token|private[ _-]*key|credentials?|authorization|auth|bearer|otp|cvv|cvc"
    r"|session[ _-]*(?:id|token|key|cookie)|ssn|one[ _-]*time(?:[ _-]*(?:password|code))?|credit[ _-]*card|card[ _-]*number|cc[ _-]*(?:number|csc))(?=$|[^a-z0-9])"
    r"|^(?:key|cookie|session|pin)(?:[ _-]*(?:id|value))?$|パスワード|暗証番号|認証(?:コード|情報|トークン|キー)|ワンタイム(?:パスワード|コード)|秘密鍵|秘密キー|シークレット|アクセストークン|APIキー", re.IGNORECASE)
ROLE_MAP = {
    'push button': 'button', 'button': 'button', 'toggle button': 'button', 'switch': 'switch',
    'text': 'textbox', 'entry': 'textbox', 'password text': 'textbox', 'editbar': 'textbox', 'document text': 'textbox', 'terminal': 'textbox',
    'check box': 'checkbox', 'check menu item': 'menuitem', 'radio button': 'radio', 'radio menu item': 'menuitem', 'menu item': 'menuitem',
    'combo box': 'combobox', 'list item': 'listitem', 'link': 'link', 'page tab': 'tab', 'page tab list': 'tablist', 'menu': 'menu', 'menu bar': 'menu',
    'slider': 'slider', 'spin button': 'spinbutton', 'scroll bar': 'slider', 'scroll pane': 'region', 'progress bar': 'progressbar', 'status bar': 'status',
    'label': 'text', 'static': 'text', 'heading': 'heading', 'paragraph': 'paragraph', 'image': 'img', 'icon': 'img', 'tool bar': 'toolbar',
    'table': 'table', 'table row': 'row', 'table cell': 'cell', 'table column header': 'columnheader', 'table row header': 'rowheader',
    'tree': 'tree', 'tree table': 'tree', 'tree item': 'treeitem', 'list': 'list', 'list box': 'listbox', 'dialog': 'dialog', 'alert': 'alert',
    'frame': 'window', 'window': 'window', 'notification': 'alert', 'tooltip': 'status', 'article': 'article', 'section': 'region', 'form': 'region',
    'caption': 'caption', 'block quote': 'blockquote', 'code': 'code', 'figure': 'figure', 'grid': 'grid', 'grid cell': 'gridcell',
}


class X11PidWalker:
    """Read-only libX11 walk (ctypes) collecting the _NET_WM_PID of every client window under a display's root.

    The connection is opened per walk and closed again: a persistent X client would keep an on-demand
    Xwayland alive. The pid set is cached for CACHE_S so one discover pass walks the tree once. A window
    destroyed mid-walk only yields a handled X error, never an abort: the no-op error handler is installed
    once and stays referenced for the process lifetime. Only read-only calls are made (XInternAtom with
    only_if_exists, XQueryTree, XGetWindowProperty); every buffer X returns is freed with XFree.
    """

    MAX_WINDOWS = 4096
    CACHE_S = 0.05  # one walk serves the window_record calls of a single discover pass

    def __init__(self):
        self._lib = None
        self._lib_loaded = False
        self._error_handler = None  # referenced for the process lifetime; installed at most once
        self._cache = None  # (monotonic time, display name, set of pids)

    def client_pids(self, display):
        """Set of pids owning an X client window on the display; empty on any failure. Never raises."""
        now = time.monotonic()
        if self._cache is not None and self._cache[1] == display and now - self._cache[0] < self.CACHE_S:
            return self._cache[2]
        try:
            pids = self._client_pids(display)
        except Exception:
            pids = set()
        self._cache = (now, display, pids)
        return pids

    @staticmethod
    def _load_lib():
        import ctypes
        import ctypes.util

        for name in (ctypes.util.find_library('X11'), 'libX11.so.6'):
            if not name:
                continue
            try:
                lib = ctypes.CDLL(name)
                c_ulong_p = ctypes.POINTER(ctypes.c_ulong)
                lib.XOpenDisplay.restype = ctypes.c_void_p
                lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
                lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
                lib.XInternAtom.restype = ctypes.c_ulong
                lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
                lib.XSetErrorHandler.restype = ctypes.c_void_p
                lib.XSetErrorHandler.argtypes = [ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)]
                lib.XQueryTree.restype = ctypes.c_int
                # children_return is Window**: a wrong pointer depth here makes every call raise and the walk silently empty.
                lib.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, c_ulong_p, c_ulong_p, ctypes.POINTER(c_ulong_p),
                                           ctypes.POINTER(ctypes.c_uint)]
                lib.XGetWindowProperty.restype = ctypes.c_int
                lib.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
                                                   ctypes.c_long, ctypes.c_int, ctypes.c_ulong, c_ulong_p,
                                                   ctypes.POINTER(ctypes.c_int), c_ulong_p, c_ulong_p,
                                                   ctypes.POINTER(ctypes.c_void_p)]
                lib.XFree.argtypes = [ctypes.c_void_p]
                lib.XDefaultRootWindow.restype = ctypes.c_ulong
                lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
                return lib
            except OSError:
                continue
        return None

    def _client_pids(self, display):
        import ctypes

        if not self._lib_loaded:
            self._lib, self._lib_loaded = self._load_lib(), True
        lib = self._lib
        if lib is None:
            return set()
        handle = lib.XOpenDisplay(display.encode('utf-8', 'replace'))
        if not handle:
            return set()
        try:
            if self._error_handler is None:
                handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)(lambda display, event: 0)
                self._error_handler = handler
                lib.XSetErrorHandler(handler)
            pid_atom = lib.XInternAtom(handle, b'_NET_WM_PID', 1)
            if not pid_atom:
                return set()  # the atom does not exist on this server: no window can carry a pid

            def query_tree(window):
                root_return = ctypes.c_ulong()
                parent_return = ctypes.c_ulong()
                child_list = ctypes.POINTER(ctypes.c_ulong)()
                n_children = ctypes.c_uint()
                if not lib.XQueryTree(handle, window, ctypes.byref(root_return), ctypes.byref(parent_return),
                                      ctypes.byref(child_list), ctypes.byref(n_children)):
                    return []
                out = list(child_list[:min(n_children.value, self.MAX_WINDOWS)]) if child_list else []
                lib.XFree(child_list)
                return out

            def window_pid(window):
                # XGetWindowProperty allocates *prop even for format 32; read the first value and free the buffer.
                actual_type = ctypes.c_ulong()
                actual_format = ctypes.c_int()
                bytes_after = ctypes.c_ulong()
                length = ctypes.c_ulong()
                data = ctypes.c_void_p()
                status = lib.XGetWindowProperty(handle, window, pid_atom, 0, 1, 0, 0, ctypes.byref(actual_type),
                                                ctypes.byref(actual_format), ctypes.byref(length), ctypes.byref(bytes_after),
                                                ctypes.byref(data))
                pid = None
                if data:
                    if not status and length.value >= 1 and actual_format.value == 32:
                        pid = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] or None
                    lib.XFree(data)
                return pid

            queue = query_tree(lib.XDefaultRootWindow(handle))
            pids = set()
            seen = set()
            checked = 0
            while queue and checked < self.MAX_WINDOWS:
                window = queue.pop(0)
                if window in seen:
                    continue
                seen.add(window)
                checked += 1
                pid = window_pid(window)
                if pid:
                    pids.add(pid)
                if checked < self.MAX_WINDOWS:
                    queue.extend(query_tree(window))  # a reparenting window manager hides the client under a frame
            return pids
        finally:
            lib.XCloseDisplay(handle)


X11_WALKER = X11PidWalker()


def display_ids_for(target_pid):
    """display_ids for a target: x11:<DISPLAY> on an X session; on Wayland only when the pid owns an X client window (XWayland)."""
    display = os.environ.get('DISPLAY', '')
    if not display:
        return []
    token = 'x11:' + display[:120]
    if not os.environ.get('WAYLAND_DISPLAY'):
        return [token]
    return [token] if target_pid and target_pid in X11_WALKER.client_pids(display) else []


class HelperError(Exception):
    def __init__(self, code, message='', may_have_executed=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.may_have_executed = may_have_executed


def usage(message):
    sys.stderr.write('adl-linux-atspi-helper: ' + message + '\n'
                     'usage: adl-linux-atspi-helper --app-id <AT-SPI application name> --app-path </absolute/executable> '
                     '[--allow-all] [--controls-file <json>] [--operation-mode standard|ask] [--restrict-targets]\n')
    sys.exit(2)


def parse_args(argv):
    opts = {'app_id': None, 'app_path': None, 'allow_all': False, 'controls': None, 'mode': None, 'release': False}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--release-input':
            opts['release'] = True
        elif arg in ('--allow-all', '--restrict-targets', '--visual-enabled', '--lifecycle-enabled'):
            if arg == '--allow-all':
                opts['allow_all'] = True
        elif arg in ('--app-id', '--app-path', '--controls-file', '--operation-mode', '--interactive-config'):
            if i + 1 >= len(argv):
                usage('missing value for ' + arg)
            value = argv[i + 1]
            i += 1
            if arg == '--app-id':
                opts['app_id'] = value
            elif arg == '--app-path':
                opts['app_path'] = value
            elif arg == '--controls-file':
                opts['controls'] = value
            elif arg == '--operation-mode':
                # ask = standard plus the Engine's one-shot `approved:true` on consequential controls.
                if value not in ('standard', 'ask'):
                    usage('unsupported --operation-mode ' + value)
                opts['mode'] = value
        else:
            usage('unknown argument ' + arg)
        i += 1
    return opts


def load_controls(path):
    try:
        if os.path.getsize(path) > MAX_LINE:
            usage('controls file too large')
        with open(path, 'r', encoding='utf-8') as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        usage('controls file unreadable: ' + type(error).__name__)
    if not isinstance(raw, dict) or len(raw) > 256:
        usage('controls file must be an object of at most 256 entries')
    controls = {}
    for key, entry in raw.items():
        if not isinstance(key, str) or not key or len(key) > 256 or not isinstance(entry, dict) or set(entry) != {'role', 'allowed'}:
            usage('controls entry must be {"role": <role>, "allowed": [actions]}')
        role, allowed = entry['role'], entry['allowed']
        if not isinstance(role, str) or not role or not isinstance(allowed, list) or not allowed or len(allowed) > 5 \
                or any(action not in ('click', 'fill', 'check', 'select', 'scroll') for action in allowed):
            usage('controls entry for ' + key + ' is invalid')
        controls[key] = (role.strip().lower().replace('_', ' '), tuple(allowed))
    return controls


def proc_identity(pid):
    """(canonical executable, start time) of a live process, or None."""
    try:
        exe = os.readlink('/proc/%d/exe' % pid)
        with open('/proc/%d/stat' % pid, 'rb') as handle:
            stat = handle.read()
    except OSError:
        return None
    if exe.endswith(' (deleted)'):
        exe = exe[:-10]
    fields = stat.rsplit(b')', 1)[1].split()
    if len(fields) < 20:
        return None
    return (exe, fields[19].decode('ascii', 'replace'))


def bounded(text):
    if not isinstance(text, str):
        return ''
    text = text.replace('\x00', '')
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT]


def consequential_label(text):
    # camelCase and _/- separated ids (btnDelete, delete_all) are split like the browser path does.
    return bool(text) and CONSEQUENTIAL.search(re.sub(r'[_-]+', ' ', split_camel(unicodedata.normalize('NFKC', text)))) is not None


def split_camel(text):
    text = re.sub(r'([A-Z])([A-Z][a-z])', r'\1 \2', text)
    text = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', text)
    text = re.sub(r'([A-Za-z])([0-9])', r'\1 \2', text)
    return re.sub(r'([0-9])([A-Za-z])', r'\1 \2', text)


def is_secret_label(*labels):
    import unicodedata
    return any(isinstance(label, str) and SECRET.search(split_camel(unicodedata.normalize('NFKC', label))) for label in labels)


class Prerequisites:
    """Lazy AT-SPI binding. Failures stay recoverable errors with an installation hint."""

    def __init__(self):
        self.atspi = None
        self.glib = None
        self.error = None

    def ensure(self):
        if self.atspi is not None:
            return
        if self.error is not None:
            raise HelperError('E_ATSPI_UNAVAILABLE', self.error)
        try:
            self._load()
        except HelperError as error:
            self.error = error.message
            sys.stderr.write('adl-linux-atspi-helper: ' + error.message + '\n')
            raise

    def _load(self):
        hint = ' Install python3-gi, gir1.2-atspi-2.0 and at-spi2-core, enable toolkit accessibility (gsettings set org.gnome.desktop.interface toolkit-accessibility true) and restart the MCP server.'
        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi, GLib, Gio
        except (ImportError, ValueError) as error:
            raise HelperError('E_ATSPI_UNAVAILABLE', 'python3-gi or the Atspi 2.0 typelib is missing (%s).%s' % (type(error).__name__, hint))
        if not os.environ.get('AT_SPI_BUS_ADDRESS'):
            try:
                bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                reply = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', None, GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 3000, None)
                if not reply.unpack()[0]:
                    raise HelperError('E_ATSPI_UNAVAILABLE', 'the accessibility bus reported no address.' + hint)
            except HelperError:
                raise
            except Exception as error:  # GLib.Error without a session bus or without org.a11y.Bus
                raise HelperError('E_ATSPI_UNAVAILABLE', 'no accessibility bus is reachable from this session (%s).%s' % (type(error).__name__, hint))
        # libatspi aborts the process when it cannot connect; prove the connection in a disposable child first.
        pid = os.fork()
        if pid == 0:
            try:
                sys.stderr = open(os.devnull, 'w')
                os._exit(0 if Atspi.init() in (0, 1) else 3)
            except BaseException:
                os._exit(3)
        deadline = time.monotonic() + 10
        status = None
        while time.monotonic() < deadline:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                break
            time.sleep(0.05)
        else:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
            raise HelperError('E_ATSPI_UNAVAILABLE', 'connecting to the accessibility bus timed out.' + hint)
        if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
            raise HelperError('E_ATSPI_UNAVAILABLE', 'libatspi could not connect to the accessibility bus.' + hint)
        if Atspi.init() not in (0, 1):
            raise HelperError('E_ATSPI_UNAVAILABLE', 'Atspi.init failed.' + hint)
        warnings.simplefilter('ignore')
        self.atspi, self.glib = Atspi, GLib


class Backend:
    def __init__(self, prereq, app_id, app_path):
        self.prereq = prereq
        self.app_id = app_id
        self.app_path = os.path.realpath(app_path)
        self.targets = {}
        self.sessions = {}

    # ---- GLib / AT-SPI plumbing -------------------------------------------------
    @property
    def A(self):
        return self.prereq.atspi

    def pump(self):
        context = self.prereq.glib.MainContext.default()
        count = 0
        while context.pending() and count < 256:
            context.iteration(False)
            count += 1

    def states(self, node):
        try:
            return set(state.value_nick for state in node.get_state_set().get_states())
        except Exception:
            return None

    def is_enabled(self, node, states):
        """ENABLED and SENSITIVE; GTK 4 only ever reports SENSITIVE (a disabled widget lacks it), so for GTK 4 SENSITIVE alone counts."""
        if 'sensitive' not in states:
            return False
        if 'enabled' in states:
            return True
        try:
            application = node.get_application()
            return (application.get_toolkit_name() or '').lower() == 'gtk' and (application.get_toolkit_version() or '').startswith('4')
        except Exception:
            return False

    def has(self, node, name):
        try:
            return node.get_state_set().contains(getattr(self.A.StateType, name))
        except Exception:
            return False

    def role_name(self, node):
        try:
            return (node.get_role_name() or '').lower()
        except Exception:
            return ''

    def name(self, node):
        try:
            return bounded(node.get_name() or '')
        except Exception:
            return ''

    def accessible_id(self, node):
        try:
            value = node.get_accessible_id()
        except Exception:
            return ''
        return bounded(value or '')

    def children(self, node):
        out = []
        try:
            count = min(node.get_child_count(), MAX_ELEMENTS)
            for index in range(count):
                child = node.get_child_at_index(index)
                if child is not None:
                    out.append(child)
        except Exception:
            pass
        return out

    def apps(self):
        try:
            desktop = self.A.get_desktop(0)
        except Exception:
            raise HelperError('E_ATSPI_UNAVAILABLE', 'the accessibility desktop is unavailable')
        return self.children(desktop)

    def action_names(self, node):
        try:
            action = node.get_action_iface()
            if action is None:
                return []
            return [(self.A.Action.get_action_name(action, index) or '').lower() for index in range(min(self.A.Action.get_n_actions(action), 16))]
        except Exception:
            return []

    def text_value(self, node, sensitive):
        if sensitive:
            return None
        try:
            if node.get_text_iface() is None:
                return None
            count = self.A.Text.get_character_count(node)
            return bounded(self.A.Text.get_text(node, 0, min(count, MAX_TEXT)) or '')
        except Exception:
            return None

    def numeric_value(self, node):
        try:
            if node.get_value_iface() is None:
                return None
            return bounded(('%g' % self.A.Value.get_current_value(node)))
        except Exception:
            return None

    def selected_name(self, node):
        """Name of the first selected child (combo boxes expose their current item through Selection)."""
        try:
            if node.get_selection_iface() is None or self.A.Selection.get_n_selected_children(node) < 1:
                return ''
            return self.name(self.A.Selection.get_selected_child(node, 0))
        except Exception:
            return ''

    def labelled_by(self, node):
        try:
            relations = node.get_relation_set() or []
            for relation in relations:
                if relation.get_relation_type() == self.A.RelationType.LABELLED_BY:
                    parts = [self.name(relation.get_target(i)) for i in range(min(relation.get_n_targets(), 4))]
                    return bounded(' '.join(part for part in parts if part))
        except Exception:
            pass
        return ''

    def extents(self, node):
        try:
            component = node.get_component_iface()
            if component is None:
                return None
            rect = self.A.Component.get_extents(component, self.A.CoordType.SCREEN)
            return {'x': int(rect.x), 'y': int(rect.y), 'width': max(0, int(rect.width)), 'height': max(0, int(rect.height))}
        except Exception:
            return None

    # ---- identity -------------------------------------------------------------
    def matching_apps(self):
        """Running AT-SPI applications whose name equals app_id and whose /proc exe is the canonical app path."""
        found = []
        for app in self.apps():
            try:
                if (app.get_name() or '') != self.app_id:
                    continue
                pid = app.get_process_id()
            except Exception:
                continue
            identity = proc_identity(pid)
            if identity is None or identity[0] != self.app_path:
                continue
            found.append((pid, identity[1], app))
        return found

    def live_target(self, target_id):
        target = self.targets.get(target_id)
        if target is None:
            raise HelperError('E_NO_TARGET', 'unknown target')
        identity = proc_identity(target['pid'])
        if identity is None or identity != (self.app_path, target['start']):
            self.drop_target(target_id)
            raise HelperError('E_TARGET_NOT_FOUND', 'the application process ended or was replaced')
        window = target['window']
        try:
            alive = not window.get_state_set().contains(self.A.StateType.DEFUNCT) and self.role_name(window) in WINDOW_ROLES
            alive = alive and any(child == window for child in self.children(target['app']))
        except Exception:
            alive = False
        if not alive:
            self.drop_target(target_id)
            raise HelperError('E_TARGET_NOT_FOUND', 'the window was closed, hidden or replaced')
        return target

    def drop_target(self, target_id):
        self.targets.pop(target_id, None)
        for session_id in [sid for sid, session in self.sessions.items() if session['target_id'] == target_id]:
            del self.sessions[session_id]

    def window_record(self, target):
        window = target['window']
        bounds = self.extents(window) or {'x': 0, 'y': 0, 'width': 0, 'height': 0}
        bounds['coordinate_space'] = 'desktop_physical_pixels'
        return {'target_id': target['id'], 'application_id': self.app_id, 'label': self.name(window),
                'window': {'bounds': bounds, 'display_ids': display_ids_for(target['pid']), 'minimized': self.has(window, 'ICONIFIED')}}

    # ---- operations -----------------------------------------------------------
    def discover(self, policy_active):
        self.pump()
        seen = {}
        for pid, start, app in self.matching_apps():
            for window in self.children(app):
                try:
                    if self.role_name(window) not in WINDOW_ROLES or self.has(window, 'DEFUNCT'):
                        continue
                except Exception:
                    continue
                existing = next((t for t in self.targets.values() if t['pid'] == pid and t['start'] == start and t['window'] == window), None)
                target = existing or {'id': 't_' + secrets.token_hex(12), 'pid': pid, 'start': start, 'app': app, 'window': window}
                seen[target['id']] = target
                if len(seen) >= MAX_TARGETS:
                    break
        for target_id in list(self.targets):
            if target_id not in seen:
                self.drop_target(target_id)
        self.targets = seen
        return {'protocol_version': 2, 'targets': [self.window_record(t) for t in seen.values()], 'mutations_enabled': policy_active,
                'focus_control': 'probe_guarded_semantic', 'visual_capture': False}

    def open(self, target_id, mode):
        if mode == 'strict_isolated':
            raise HelperError('E_INTERFERENCE_RISK', 'desktop strict isolation is unavailable')
        if mode != 'background_semantic':
            raise HelperError('E_UNSUPPORTED_ACTION', 'physical input is unsupported on Linux')
        self.pump()
        self.live_target(target_id)
        if len(self.sessions) >= MAX_SESSIONS:
            raise HelperError('E_RESOURCE_LIMIT', 'too many sessions')
        session_id = 's_' + secrets.token_hex(12)
        self.sessions[session_id] = {'id': session_id, 'target_id': target_id, 'revision': 0, 'fingerprint': None, 'handles': {}, 'ids': {}, 'counter': 0}
        return {'session_id': session_id}

    def session(self, target_id, session_id):
        session = self.sessions.get(session_id)
        if session is None:
            raise HelperError('E_NO_SESSION', 'unknown session')
        if session['target_id'] != target_id:
            raise HelperError('E_TARGET_MISMATCH', 'session belongs to another target')
        try:
            target = self.live_target(target_id)
        except HelperError:
            self.sessions.pop(session_id, None)
            raise
        return session, target

    def close(self, target_id, session_id):
        session = self.sessions.get(session_id)
        if session is None:
            raise HelperError('E_NO_SESSION', 'unknown session')
        if session['target_id'] != target_id:
            raise HelperError('E_TARGET_MISMATCH', 'session belongs to another target')
        del self.sessions[session_id]
        return {}

    def classify(self, node, parent_role, parent_parent_role):
        """Public role, name, value and flags for one accessible, or None when it is not an observable element."""
        atspi_role = self.role_name(node)
        states = self.states(node)
        if states is None or 'defunct' in states:
            return None
        public = ROLE_MAP.get(atspi_role, 'generic')
        if not parent_role and atspi_role in WINDOW_ROLES:
            public = 'window'  # the walk root is the target window whatever role its toolkit gives it
        if atspi_role == 'list item' and 'selectable' in states:
            public = 'option'
        if atspi_role == 'menu item' and parent_role == 'menu' and parent_parent_role == 'combo box':
            public = 'option'
        if public == 'textbox' and 'editable' not in states and atspi_role != 'password text':
            public = 'text'
        if atspi_role == 'toggle button' and ('checked' in states or 'pressed' in states):
            public = 'checkbox'
        accessible_id = self.accessible_id(node)
        raw_name = name = self.name(node)
        if not name and public in PUBLIC_ROLES:
            name = self.labelled_by(node)
        if atspi_role == 'scroll bar' and not name:
            name = 'scroll bar (%s)' % ('vertical' if 'vertical' in states else 'horizontal')
        visible = 'visible' in states or 'showing' in states
        if not visible or (public == 'generic' and not name and not accessible_id):
            return None
        sensitive = atspi_role == 'password text' or is_secret_label(name, accessible_id)
        record = {'role': public, 'name': name, 'enabled': self.is_enabled(node, states)}
        value = None
        if public in ('textbox',) or (public == 'text' and atspi_role not in ('label', 'static')):
            value = self.text_value(node, sensitive)
        elif public == 'combobox':
            value = self.selected_name(node) or name
        elif public in ('slider', 'spinbutton', 'progressbar'):
            value = self.numeric_value(node)
        if value is not None and not sensitive:
            record['value'] = value
        if public in ('checkbox', 'radio', 'switch') or atspi_role in ('check menu item', 'radio menu item', 'toggle button'):
            record['checked'] = 'checked' in states or 'pressed' in states
        if public in ('option', 'listitem', 'tab', 'treeitem', 'row', 'cell') or 'selectable' in states:
            record['selected'] = 'selected' in states
        if sensitive:
            record['sensitive'] = True
        return record, atspi_role, accessible_id, states, raw_name

    def walk(self, root, visit, deadline):
        """Bounded depth-first traversal; returns True when the bound or deadline truncated it."""
        stack = [(root, '', '')]
        count = 0
        while stack:
            if count >= MAX_ELEMENTS or time.monotonic() > deadline:
                return True
            node, parent_role, grand_role = stack.pop()
            count += 1
            if visit(node, parent_role, grand_role) is False:
                continue
            role = self.role_name(node)
            kids = self.children(node)
            for child in reversed(kids):
                stack.append((child, role, parent_role))
        return False

    def snapshot(self, target_id, session_id):
        self.pump()
        session, target = self.session(target_id, session_id)
        deadline = time.monotonic() + WALK_DEADLINE_S
        elements, handles, ids, budget = [], {}, {}, [2 + len('{"revision":123456789,"truncated":false,"elements":[]}')]
        state = {'truncated': False}

        def visit(node, parent_role, grand_role):
            if self.has(node, 'DEFUNCT'):
                return False
            classified = self.classify(node, parent_role, grand_role)
            if classified is None:
                return True
            record, atspi_role, accessible_id, states, raw_name = classified
            element_id = session['ids'].get(node)
            if element_id is None:
                session['counter'] += 1
                element_id = 'e%d' % session['counter']
            ids[node] = element_id
            full = {'id': element_id}
            full.update(record)
            encoded = json.dumps(full, ensure_ascii=False, separators=(',', ':'))
            size = len(encoded.encode('utf-8')) + 1
            if budget[0] + size > MAX_REPLY or len(elements) >= MAX_ELEMENTS:
                state['truncated'] = True
                return False
            budget[0] += size
            elements.append(full)
            handles[element_id] = {'node': node, 'role': record['role'], 'atspi_role': atspi_role, 'name': record['name'], 'raw_name': raw_name, 'accessible_id': accessible_id,
                                   'sensitive': record.get('sensitive', False), 'enabled': record['enabled'], 'states': states}
            return True

        truncated = self.walk(target['window'], visit, deadline) or state['truncated']
        fingerprint = hashlib.sha256(json.dumps(elements, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if fingerprint != session['fingerprint']:
            session['revision'] += 1
            session['fingerprint'] = fingerprint
        session['handles'], session['ids'] = handles, ids
        return {'revision': session['revision'], 'truncated': truncated, 'elements': elements}

    # ---- focus probe ------------------------------------------------------------
    def focus_signature(self, target):
        active = []
        for app in self.apps():
            try:
                pid = app.get_process_id()
                for window in self.children(app)[:MAX_TARGETS]:
                    if self.has(window, 'ACTIVE'):
                        active.append((pid, self.role_name(window), self.name(window)))
            except Exception:
                active.append(('error',))
        focused = []

        def visit(node, parent_role, grand_role):
            if self.has(node, 'FOCUSED'):
                focused.append((self.role_name(node), self.name(node), self.accessible_id(node)))
                return False
            return True

        self.walk(target['window'], visit, time.monotonic() + 2.0)
        return (sorted(active), sorted(focused))

    # ---- act --------------------------------------------------------------------
    def act(self, policy, request):
        self.pump()
        session, target = self.session(request['target_id'], request['session_id'])
        if request['expected_revision'] != session['revision'] or session['revision'] == 0:
            raise HelperError('E_STALE_REVISION', 'observe again before acting')
        handle = session['handles'].get(request['element_id'])
        if handle is None:
            raise HelperError('E_NO_ELEMENT', 'unknown element for this revision')
        node, action = handle['node'], request['action']
        self.verify_live(node, handle, target)
        if not handle['enabled']:
            raise HelperError('E_POLICY_DENIED', 'disabled control')
        if handle['sensitive']:
            raise HelperError('E_PRIVACY_BLOCKED', 'sensitive control')
        policy.authorize(handle, action, session, request.get('approved', False))
        before = self.focus_signature(target)
        dispatched = False
        try:
            if action == 'click':
                dispatched = self.do_click(node, handle)
            elif action == 'fill':
                dispatched = self.do_fill(node, handle, request['value'])
            elif action == 'check':
                dispatched = self.do_check(node, handle, request['checked'])
            elif action == 'select':
                dispatched = self.do_select(node, handle)
            elif action == 'scroll':
                dispatched = self.do_scroll(node, handle, request['direction'])
        except HelperError as error:
            if error.may_have_executed or dispatched:
                self.sessions.pop(session['id'], None)
            raise
        if dispatched:
            self.pump()
            after = self.focus_signature(target)
            if after != before:
                self.sessions.pop(session['id'], None)
                raise HelperError('E_FOCUS_CHANGED', 'focus or the active window changed during the action', may_have_executed=True)
        return {'applied': True}

    def verify_live(self, node, handle, target):
        try:
            if node.get_state_set().contains(self.A.StateType.DEFUNCT):
                raise HelperError('E_STALE_ELEMENT', 'element is gone')
            if self.role_name(node) != handle['atspi_role'] or self.accessible_id(node) != handle['accessible_id'] or self.name(node) != handle['raw_name']:
                raise HelperError('E_STALE_ELEMENT', 'element changed since the last snapshot')
            if not self.is_enabled(node, self.states(node) or set()):
                raise HelperError('E_POLICY_DENIED', 'the control is disabled now')
            current, depth = node, 0
            while current is not None and depth < 64:
                if current == target['window']:
                    return
                current = current.get_parent()
                depth += 1
        except HelperError:
            raise
        except Exception:
            pass
        raise HelperError('E_STALE_ELEMENT', 'element left the target window')

    def wait_until(self, predicate):
        deadline = time.monotonic() + READBACK_S
        while True:
            self.pump()
            try:
                if predicate():
                    return True
            except Exception:
                pass
            if time.monotonic() > deadline:
                return False
            time.sleep(0.03)

    def pick_action(self, node, preferred):
        names = self.action_names(node)
        for wanted in preferred:
            if wanted in names:
                return names.index(wanted)
        return None

    def do_click(self, node, handle):
        if handle['role'] not in CLICK_ROLES:
            raise HelperError('E_UNSUPPORTED_ACTION', 'click is only supported on buttons, links, menu items, tabs, options and toggles')
        index = self.pick_action(node, ('click', 'press', 'activate', 'jump'))
        if index is None:
            raise HelperError('E_PATTERN_UNSUPPORTED', 'the control advertises no click action')
        try:
            ok = self.A.Action.do_action(node, index)
        except Exception:
            raise HelperError('E_INTERNAL', 'the click action failed', may_have_executed=True)
        if not ok:
            raise HelperError('E_NOT_INTERACTABLE', 'the control refused the click action')
        time.sleep(0.05)
        return True

    def do_fill(self, node, handle, value):
        if handle['role'] != 'textbox' or node.get_editable_text_iface() is None or 'editable' not in handle['states'] or 'read-only' in handle['states']:
            raise HelperError('E_NOT_INTERACTABLE', 'the control is not an editable text field')
        try:
            ok = self.A.EditableText.set_text_contents(node, value)
        except Exception:
            raise HelperError('E_INTERNAL', 'setting the text failed', may_have_executed=True)
        if not ok:
            raise HelperError('E_NOT_INTERACTABLE', 'the control refused the new text')
        if not self.wait_until(lambda: self.A.Text.get_text(node, 0, self.A.Text.get_character_count(node)) == value):
            raise HelperError('E_INTERNAL', 'text readback does not match the requested value', may_have_executed=True)
        return True

    def do_check(self, node, handle, desired):
        if handle['role'] not in ('checkbox', 'radio', 'switch') and handle['atspi_role'] not in ('check menu item', 'radio menu item', 'toggle button'):
            raise HelperError('E_UNSUPPORTED_ACTION', 'check is only supported on check boxes, radio buttons and toggles')
        current = self.has(node, 'CHECKED') or self.has(node, 'PRESSED')
        if current == desired:
            return False
        if handle['role'] == 'radio' and not desired:
            raise HelperError('E_UNSUPPORTED_ACTION', 'a radio button cannot be unchecked directly')
        index = self.pick_action(node, ('toggle', 'click', 'press', 'activate'))
        if index is None:
            raise HelperError('E_PATTERN_UNSUPPORTED', 'the control advertises no toggle action')
        try:
            ok = self.A.Action.do_action(node, index)
        except Exception:
            raise HelperError('E_INTERNAL', 'the toggle action failed', may_have_executed=True)
        if not ok:
            raise HelperError('E_NOT_INTERACTABLE', 'the control refused the toggle action')
        if not self.wait_until(lambda: (self.has(node, 'CHECKED') or self.has(node, 'PRESSED')) == desired):
            raise HelperError('E_INTERNAL', 'checked state readback does not match', may_have_executed=True)
        return True

    def do_select(self, node, handle):
        if handle['role'] not in SELECT_ROLES:
            raise HelperError('E_UNSUPPORTED_ACTION', 'select is only supported on options, list items, tabs and tree items')
        try:
            parent = node.get_parent()
            index = node.get_index_in_parent()
        except Exception:
            raise HelperError('E_STALE_ELEMENT', 'the option lost its container')
        if parent is None or index < 0:
            raise HelperError('E_STALE_ELEMENT', 'the option lost its container')
        container = parent
        try:
            grand = parent.get_parent()
            if self.role_name(parent) == 'menu' and grand is not None and self.role_name(grand) == 'combo box':
                container = grand
        except Exception:
            grand = None
        if container.get_selection_iface() is None:
            raise HelperError('E_PATTERN_UNSUPPORTED', 'the container offers no selection interface')
        if self.has(node, 'SELECTED') and container is parent:
            return False
        try:
            ok = self.A.Selection.select_child(container, index)
        except Exception:
            raise HelperError('E_INTERNAL', 'selection failed', may_have_executed=True)
        if not ok:
            raise HelperError('E_NOT_INTERACTABLE', 'the container refused the selection')

        def selected():
            if container is not parent:
                chosen = self.A.Selection.get_selected_child(container, 0) if self.A.Selection.get_n_selected_children(container) > 0 else None
                return chosen is not None and chosen.get_index_in_parent() == index or self.name(container) == handle['name']
            return self.has(node, 'SELECTED')
        if not self.wait_until(selected):
            raise HelperError('E_INTERNAL', 'selection readback does not match', may_have_executed=True)
        return True

    def do_scroll(self, node, handle, direction):
        bar = None
        if handle['atspi_role'] == 'scroll bar':
            bar = node
        else:
            bars = [child for child in self.children(node) if self.role_name(child) == 'scroll bar']
            vertical = [child for child in bars if self.has(child, 'VERTICAL')]
            bar = (vertical or bars or [None])[0]
        if bar is None or bar.get_value_iface() is None:
            raise HelperError('E_PATTERN_UNSUPPORTED', 'no scroll bar with a value interface')
        try:
            current, low, high = self.A.Value.get_current_value(bar), self.A.Value.get_minimum_value(bar), self.A.Value.get_maximum_value(bar)
            step = max(self.A.Value.get_minimum_increment(bar), (high - low) / 10.0, 1.0)
        except Exception:
            raise HelperError('E_PATTERN_UNSUPPORTED', 'the scroll bar value is unreadable')
        wanted = max(low, min(high, current + step if direction == 'down' else current - step))
        if abs(wanted - current) < 1e-6:
            return False
        try:
            ok = self.A.Value.set_current_value(bar, wanted)
        except Exception:
            raise HelperError('E_INTERNAL', 'scrolling failed', may_have_executed=True)
        if not ok:
            raise HelperError('E_NOT_INTERACTABLE', 'the scroll bar refused the new position')
        if not self.wait_until(lambda: abs(self.A.Value.get_current_value(bar) - current) > 1e-6):
            raise HelperError('E_INTERNAL', 'scroll position readback did not change', may_have_executed=True)
        return True


class Policy:
    def __init__(self, allow_all, controls, mode):
        self.allow_all = allow_all
        self.controls = controls
        self.standard = mode in ('standard', 'ask')
        self.ask = mode == 'ask'

    @property
    def active(self):
        return self.allow_all or self.controls is not None or self.standard

    def authorize(self, handle, action, session, approved=False):
        # `approved` is the parent's one-shot host approval. Only an ask-mode helper honours it, and only for the consequential gate:
        # sensitive controls were already refused above and --allow-all / a controls file never see the field.
        if approved and not self.ask:
            raise HelperError('E_BAD_REQUEST', 'approved is only accepted with --operation-mode ask')
        if self.allow_all:
            return
        if self.controls is not None:
            entry = self.controls.get(handle['accessible_id']) if handle['accessible_id'] else None
            if entry is None or action not in entry[1] or entry[0] not in (handle['role'], handle['atspi_role']):
                raise HelperError('E_POLICY_DENIED', 'control, role or action is not in the trusted allowlist')
            same = [h for h in session['handles'].values() if h['accessible_id'] == handle['accessible_id']]
            if len(same) != 1:
                raise HelperError('E_POLICY_DENIED', 'the accessible id is not unique within the window')
            return
        if self.standard:
            if action != 'scroll' and not approved and (consequential_label(handle['name']) or consequential_label(handle['accessible_id'])):
                raise HelperError('E_APPROVAL_REQUIRED', 'consequential control; the standard tier refuses it' if not self.ask else 'consequential control; retry with the one-shot host approval')
            return
        raise HelperError('E_POLICY_DENIED', 'mutations are disabled without --allow-all, --controls-file or --operation-mode standard')


REQUEST_FIELDS = {
    'discover': set(), 'open': {'target_id', 'mode'}, 'snapshot': {'target_id', 'session_id'}, 'close': {'target_id', 'session_id'},
    'act': {'target_id', 'session_id', 'element_id', 'expected_revision', 'action', 'value', 'checked', 'direction', 'approved'},
}


def validate(request):
    op = request.get('op')
    if op not in REQUEST_FIELDS:
        raise HelperError('E_UNSUPPORTED_ACTION', 'unsupported operation')
    extra = set(request) - REQUEST_FIELDS[op] - {'op', 'request_id'}
    if extra:
        raise HelperError('E_BAD_REQUEST', 'unknown request fields')
    for key in ('target_id', 'session_id', 'element_id', 'mode', 'action', 'direction'):
        if key in request and (not isinstance(request[key], str) or not request[key] or len(request[key]) > 128):
            raise HelperError('E_BAD_REQUEST', 'invalid ' + key)
    if op in ('open', 'snapshot', 'close', 'act') and 'target_id' not in request:
        raise HelperError('E_BAD_REQUEST', 'target_id required')
    if op in ('snapshot', 'close', 'act') and 'session_id' not in request:
        raise HelperError('E_BAD_REQUEST', 'session_id required')
    if op == 'open' and 'mode' not in request:
        raise HelperError('E_BAD_REQUEST', 'mode required')
    if op == 'act':
        if 'element_id' not in request or 'action' not in request or not isinstance(request.get('expected_revision'), int) or isinstance(request.get('expected_revision'), bool) or request['expected_revision'] < 0:
            raise HelperError('E_BAD_REQUEST', 'act needs element_id, action and expected_revision')
        action = request['action']
        if action not in ('click', 'fill', 'check', 'select', 'scroll'):
            raise HelperError('E_UNSUPPORTED_ACTION', 'unsupported action')
        if action == 'fill':
            value = request.get('value')
            if not isinstance(value, str) or len(value.encode('utf-8')) > MAX_FILL_BYTES or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', value):
                raise HelperError('E_BAD_REQUEST', 'fill needs a bounded plain-text value')
        elif action == 'check':
            if not isinstance(request.get('checked'), bool):
                raise HelperError('E_BAD_REQUEST', 'check needs a boolean checked')
        elif action == 'scroll':
            if request.get('direction') not in ('up', 'down'):
                raise HelperError('E_BAD_REQUEST', 'scroll needs direction up or down')
        for key in ('value', 'checked', 'direction'):
            if key in request and key != {'fill': 'value', 'check': 'checked', 'scroll': 'direction'}.get(action):
                raise HelperError('E_BAD_REQUEST', key + ' is not valid for ' + action)
        if 'approved' in request and request['approved'] is not True:
            raise HelperError('E_BAD_REQUEST', 'approved must be true when present')
    return op


def write_reply(payload):
    line = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    data = line.encode('utf-8')
    if len(data) > MAX_LINE - 1:
        payload = {'ok': False, 'request_id': payload.get('request_id', ''), 'error': {'code': 'E_RESOURCE_LIMIT', 'message': 'reply exceeds 64 KiB'}}
        data = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(data + b'\n')
    sys.stdout.buffer.flush()


def main():
    opts = parse_args(sys.argv[1:])
    if opts['release']:
        sys.stdout.write('{"released_input":true}\n')
        return 0
    if not opts['app_id'] or not opts['app_path'] or len(opts['app_id']) > 128 or '\x00' in opts['app_id'] or not os.path.isabs(opts['app_path']):
        usage('--app-id and an absolute --app-path are required')
    controls = load_controls(opts['controls']) if opts['controls'] is not None else None
    policy = Policy(opts['allow_all'], controls, opts['mode'])
    prereq = Prerequisites()
    backend = Backend(prereq, opts['app_id'], opts['app_path'])
    stdin = sys.stdin.buffer
    buffer = b''
    while True:
        chunk = stdin.read1(MAX_LINE) if hasattr(stdin, 'read1') else stdin.read(1)
        if not chunk:
            return 0
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            handle_line(line, policy, prereq, backend)
        if len(buffer) > MAX_LINE:
            write_reply({'ok': False, 'request_id': '', 'error': {'code': 'E_BAD_REQUEST', 'message': 'request exceeds 64 KiB'}})
            return 1


def handle_line(line, policy, prereq, backend):
    if not line.strip():
        return
    request_id = ''
    try:
        try:
            request = json.loads(line.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise HelperError('E_BAD_REQUEST', 'invalid JSON')
        if not isinstance(request, dict):
            raise HelperError('E_BAD_REQUEST', 'request must be an object')
        if request.get('op') == 'cancel_input':
            return
        raw_id = request.get('request_id')
        if not isinstance(raw_id, str) or not raw_id or len(raw_id) > 128:
            raise HelperError('E_BAD_REQUEST', 'request_id required')
        request_id = raw_id
        op = validate(request)
        prereq.ensure()
        if op == 'discover':
            result = backend.discover(policy.active)
        elif op == 'open':
            result = backend.open(request['target_id'], request['mode'])
        elif op == 'snapshot':
            result = backend.snapshot(request['target_id'], request['session_id'])
        elif op == 'act':
            result = backend.act(policy, request)
        else:
            result = backend.close(request['target_id'], request['session_id'])
        write_reply({'ok': True, 'request_id': request_id, 'result': result})
    except HelperError as error:
        reply = {'ok': False, 'request_id': request_id, 'error': {'code': error.code, 'message': error.message[:512]}}
        if error.may_have_executed:
            reply['may_have_executed'] = True
        write_reply(reply)
    except Exception as error:  # never leak tracebacks over the protocol
        sys.stderr.write('adl-linux-atspi-helper: internal error %s\n' % type(error).__name__)
        write_reply({'ok': False, 'request_id': request_id, 'error': {'code': 'E_INTERNAL', 'message': 'internal error'}})


if __name__ == '__main__':
    sys.exit(main())
