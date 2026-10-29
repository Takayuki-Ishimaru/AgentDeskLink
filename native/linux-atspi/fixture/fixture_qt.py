#!/usr/bin/python3
"""Synthetic Qt fixture (PyQt5, or PySide6 when PyQt5 is missing) for the Linux AT-SPI helper tests. Test-only.

Needs QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 (set by the tests) so Qt registers on the accessibility bus. The control
directory (ADL_FIXTURE_CONTROL) accepts the command 'quit'.
"""
import os
import sys

try:
    from PyQt5 import QtCore, QtWidgets
except ImportError:
    from PySide6 import QtCore, QtWidgets

NAME = os.environ.get('ADL_FIXTURE_APP_NAME', 'adl-fixture-qt')
CONTROL = os.environ.get('ADL_FIXTURE_CONTROL', '')
if CONTROL:
    os.makedirs(CONTROL, exist_ok=True)
QtCore.QCoreApplication.setApplicationName(NAME)
app = QtWidgets.QApplication([NAME])
window = QtWidgets.QWidget()
window.setWindowTitle('ADL Qt Fixture')
layout = QtWidgets.QVBoxLayout(window)
status = QtWidgets.QLabel('Status: ready')
layout.addWidget(status)
name = QtWidgets.QLineEdit()
name.setAccessibleName('Name')
layout.addWidget(name)
password = QtWidgets.QLineEdit()
password.setEchoMode(QtWidgets.QLineEdit.Password)
password.setAccessibleName('Password')
layout.addWidget(password)
run = QtWidgets.QPushButton('Run')
clicks = [0]


def on_run():
    clicks[0] += 1
    status.setText('Status: clicked %d' % clicks[0])


run.clicked.connect(on_run)
layout.addWidget(run)
check = QtWidgets.QCheckBox('Enabled')
layout.addWidget(check)
combo = QtWidgets.QComboBox()
combo.setAccessibleName('Flavour')
combo.addItems(['Alpha', 'Beta', 'Gamma'])
layout.addWidget(combo)
window.show()


def poll():
    if not CONTROL:
        return
    for entry in sorted(os.listdir(CONTROL)):
        path = os.path.join(CONTROL, entry)
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                command = handle.read().strip()
            os.unlink(path)
        except OSError:
            continue
        if command == 'quit':
            app.quit()


timer = QtCore.QTimer()
timer.timeout.connect(poll)
timer.start(100)
sys.stdout.write('fixture ready pid=%d\n' % os.getpid())
sys.stdout.flush()
sys.exit(app.exec_() if hasattr(app, 'exec_') else app.exec())
