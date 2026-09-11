"""Exercise the evidence runner through its CLI in an isolated fixture checkout."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

class RunnerCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        scripts = self.root / "scripts"
        scripts.mkdir()
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.runner = scripts / "workspace-recovery-run-check.py"
        shutil.copyfile(
            pathlib.Path(__file__).resolve().parents[1] /
            "workspace-recovery-run-check.py",
            self.runner,
        )

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(self.runner), *args],
            capture_output=True,
            text=True,
        )

    def test_empty_argv_has_usage_without_traceback(self):
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Usage:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_verbatim_argv_and_root_are_preserved(self):
        arg = 'literal $HOME; spaces and "quotes"'
        command = [sys.executable, "-c", "import os,sys; print(repr(sys.argv[1])); print(os.getcwd())", arg]
        result = self.run_cli("verbatim", *command)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads((self.logs / "verbatim.json").read_text())
        self.assertEqual(metadata["command"], command)
        self.assertEqual(metadata["cwd"], str(self.root))
        log = (self.logs / "verbatim.log").read_text()
        self.assertIn(repr(arg), log)
        self.assertIn(str(self.root), log)

    def test_existing_log_or_metadata_is_never_overwritten(self):
        for suffix in (".log", ".json"):
            with self.subTest(suffix=suffix):
                name = "existing-" + suffix[1:]
                existing = self.logs / (name + suffix)
                existing.write_text("preserved evidence")
                result = self.run_cli(name, sys.executable, "-c", 'print("replacement")')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("never overwritten", result.stderr)
                self.assertEqual(existing.read_text(), "preserved evidence")
                self.assertEqual(len(list(self.logs.glob(name + ".*"))), 1)

    def test_exit_code_propagates_to_cli_and_metadata(self):
        result = self.run_cli("failed-command", sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7)
        metadata = json.loads((self.logs / "failed-command.json").read_text())
        self.assertEqual(metadata["exit_code"], 7)

if __name__ == "__main__":
    unittest.main()
