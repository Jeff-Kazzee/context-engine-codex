"""Test archive validation without extracting package files or running pnpm."""
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('archive_validator', Path(__file__).with_name('validate-pnpm-archive.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class ArchiveValidationTests(unittest.TestCase):
    def make_archive(self, extra=None):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name in ['package/package.json', 'package/bin/pnpm.mjs', 'package/dist/pnpm.mjs']:
                member = tarfile.TarInfo(name)
                member.size = 2
                archive.addfile(member, io.BytesIO(b'{}'))
            if extra is not None:
                archive.addfile(extra, io.BytesIO(b''))
        return data.getvalue()

    def check(self, data, accepted):
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            if accepted:
                validator.validate_members(archive)
            else:
                with self.assertRaises(ValueError):
                    validator.validate_members(archive)

    def test_accepts_regular_package_files_without_extraction(self):
        self.check(self.make_archive(), True)

    def test_rejects_paths_outside_the_package(self):
        for name in ['../outside', '/absolute', 'package/../outside', 'package/back\\slash', 'package/line\nbreak']:
            with self.subTest(name=name):
                self.check(self.make_archive(tarfile.TarInfo(name)), False)

    def test_rejects_links_special_files_and_duplicate_paths(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            with self.subTest(kind=kind):
                member = tarfile.TarInfo('package/link')
                member.type = kind
                member.linkname = '../outside'
                self.check(self.make_archive(member), False)
        self.check(self.make_archive(tarfile.TarInfo('package/package.json')), False)


if __name__ == '__main__':
    unittest.main()
