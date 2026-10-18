"""Extract wrapper imports with enforced actual byte/file limits, never links.

Password is passed through a private subprocess environment, not URL/argv.
Central-directory validation in state-transfer.js precedes this second boundary.
"""
import os
import pathlib
import stat
import sys
import zipfile


def extract(archive, destination):
    root = pathlib.Path(destination).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    password = os.environ.get("WRAPPER_ARCHIVE_PASSWORD", "").encode("utf-8")
    maximum = int(os.environ.get("IMPORT_EXPANDED_MAX_BYTES", str(4 * 1024**3)))
    max_entries = int(os.environ.get("IMPORT_MAX_ENTRIES", "100000"))
    total = 0
    # Info-ZIP stores UTF-8 names even when it omits the UTF-8 flag. Match the
    # Node preflight's byte decoding rather than silently changing filenames.
    with zipfile.ZipFile(archive, metadata_encoding="utf-8") as source:
        members = source.infolist()
        if not members or len(members) > max_entries:
            raise ValueError("Archive is empty or has too many entries")
        for member in members:
            parts = member.filename.rstrip("/").split("/")
            if any(p in ("", ".", "..") for p in parts) or "\\" in member.filename or ":" in parts[0]:
                raise ValueError("Unsafe archive path")
            kind = stat.S_IFMT(member.external_attr >> 16)
            if kind not in (0, stat.S_IFDIR, stat.S_IFREG):
                raise ValueError("Links and special files are unsupported")
            target = root.joinpath(*parts)
            if root not in target.resolve().parents:
                raise ValueError("Archive path escapes destination")
            if member.is_dir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            # Exclusive creation rejects duplicate/overlapping output members.
            with source.open(member, pwd=password or None) as incoming, open(target, "xb") as outgoing:
                os.chmod(target, 0o700 if member.external_attr >> 16 & stat.S_IXUSR else 0o600)
                while True:
                    chunk = incoming.read(min(65536, max(1, maximum - total + 1)))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum:
                        raise ValueError("Archive exceeds expanded-size limit")
                    outgoing.write(chunk)


if __name__ == "__main__":
    try:
        extract(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(82 if "password" in str(error).lower() else 1)
