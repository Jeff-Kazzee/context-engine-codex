"""Validate the verified pnpm archive before the CI installer extracts it."""
import pathlib
import sys
import tarfile


def validate_members(archive):
    names = set()
    files = set()
    expanded = 0
    for member in archive:
        name = member.name
        expanded += member.size
        if len(names) >= 2000 or expanded > 64 * 1024 * 1024:
            raise ValueError('Archive exceeds the reviewed size bounds.')
        parts = name.split('/')
        if (not name.startswith('package/') or len(name) > 512 or '\\' in name
                or any(ord(character) < 32 for character in name)
                or any(part in ('', '.', '..') for part in parts)
                or pathlib.PurePosixPath(name).is_absolute()):
            raise ValueError('Unsafe archive path.')
        if not (member.isfile() or member.isdir()) or member.mode & 0o7000:
            raise ValueError('Archive links and special file types are forbidden.')
        if name in names:
            raise ValueError('Duplicate archive path.')
        names.add(name)
        if member.isfile():
            files.add(name)
    required = {'package/package.json', 'package/bin/pnpm.mjs', 'package/dist/pnpm.mjs'}
    if not required <= files:
        raise ValueError('Required pnpm files are absent.')


def validate(archive_path):
    with tarfile.open(archive_path, 'r:gz') as archive:
        validate_members(archive)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/validate-pnpm-archive.py ARCHIVE')
    validate(sys.argv[1])
