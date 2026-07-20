"""POSIX dirfd-anchored, locked, rollback-on-error repository writers."""

from __future__ import annotations

import contextlib
import base64
import binascii
import fcntl
import hashlib
import json
import os
import pathlib
import secrets
import stat


JOURNAL_NAME = "write-journal-v1.json"
RECOVERABLE_PATHS = frozenset({
    ".harness/config.json",
    ".harness/evidence_ledger.py",
    ".github/workflows/ci.yml",
    ".github/workflows/coolify-deploy.yml",
    ".github/workflows/backend-prepare.yml",
    ".github/workflows/coolify-rollback.yml",
    ".github/workflows/bootstrap-deployment-evidence.yml",
    ".github/workflows/evidence-retention-checkpoint.yml",
})


class _Destination:
    def __init__(
        self,
        *,
        path: pathlib.Path,
        parent_parts: tuple[str, ...],
        name: str,
        parent_fd: int,
        content: bytes,
        existed: bool,
        original: bytes | None,
        mode: int,
    ) -> None:
        self.path = path
        self.parent_parts = parent_parts
        self.name = name
        self.parent_fd = parent_fd
        self.content = content
        self.existed = existed
        self.original = original
        self.mode = mode
        self.temporary: str | None = None


def _require_secure_dirfd_support() -> None:
    required_flags = ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC")
    required_functions = (os.open, os.mkdir, os.stat, os.unlink)
    if (
        os.name != "posix"
        or any(not hasattr(os, flag) for flag in required_flags)
        or any(function not in os.supports_dir_fd for function in required_functions)
    ):
        raise RuntimeError(
            "secure repository writes require POSIX dir_fd operations, O_NOFOLLOW, and O_DIRECTORY"
        )


def _absolute(path: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(os.path.abspath(os.fspath(path)))


def _relative_parts(root: pathlib.Path, path: pathlib.Path) -> tuple[str, ...]:
    root = _absolute(root)
    path = _absolute(path)
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise ValueError(f"write path escapes repository root: {path}") from None
    if not relative.parts:
        raise ValueError("repository root itself is not a writable file destination")
    return tuple(relative.parts)


def _open_root(root: pathlib.Path) -> int:
    _require_secure_dirfd_support()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        return os.open(_absolute(root), flags)
    except OSError as exc:
        raise ValueError(f"repository root must be a real directory: {root}: {exc}") from None


def _open_child_directory(parent_fd: int, name: str) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        return os.open(name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        raise
    except (NotADirectoryError, OSError) as exc:
        raise ValueError(
            f"repository write parent contains a symlink or non-directory component: {name}"
        ) from exc


def _open_parent(root_fd: int, parts: tuple[str, ...], *, create: bool) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                child = _open_child_directory(current, part)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, 0o755, dir_fd=current)
                    _fsync_directory(current)
                except FileExistsError:
                    pass
                child = _open_child_directory(current, part)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def _assert_parent_identity(
    root_fd: int,
    parent_parts: tuple[str, ...],
    retained_fd: int,
) -> None:
    """Verify the lexical parent still names the opened directory before commit."""
    try:
        current_fd = _open_parent(root_fd, parent_parts, create=False)
    except (ValueError, FileNotFoundError):
        raise ValueError("repository write parent changed or became a symlink") from None
    try:
        expected = os.fstat(retained_fd)
        current = os.fstat(current_fd)
        if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("repository write parent changed after it was opened")
    finally:
        os.close(current_fd)


def _leaf_metadata(parent_fd: int, name: str):
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError(f"repository write path contains a symlink: {name}")
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"repository write destination is not a regular file: {name}")
    return metadata


def _read_leaf(parent_fd: int, name: str, metadata) -> bytes:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode):
            raise ValueError(f"repository file is not a regular file: {name}")
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ValueError(f"repository file changed while it was opened: {name}")
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(descriptor)


def read_repository_file(
    root: pathlib.Path,
    path: pathlib.Path,
    *,
    missing_ok: bool = False,
) -> bytes | None:
    root = _absolute(root)
    parts = _relative_parts(root, path)
    root_fd = _open_root(root)
    parent_fd = None
    try:
        try:
            parent_fd = _open_parent(root_fd, parts[:-1], create=False)
        except (ValueError, FileNotFoundError):
            if missing_ok:
                return None
            raise
        _assert_parent_identity(root_fd, parts[:-1], parent_fd)
        metadata = _leaf_metadata(parent_fd, parts[-1])
        if metadata is None:
            if missing_ok:
                return None
            raise FileNotFoundError(path)
        return _read_leaf(parent_fd, parts[-1], metadata)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def validate_write_paths(root: pathlib.Path, paths) -> None:
    root = _absolute(root)
    root_fd = _open_root(root)
    try:
        for path in paths:
            parts = _relative_parts(root, pathlib.Path(path))
            try:
                parent_fd = _open_parent(root_fd, parts[:-1], create=False)
            except ValueError:
                raise
            except FileNotFoundError:
                continue
            try:
                _assert_parent_identity(root_fd, parts[:-1], parent_fd)
                _leaf_metadata(parent_fd, parts[-1])
            finally:
                os.close(parent_fd)
    finally:
        os.close(root_fd)


@contextlib.contextmanager
def repository_write_lock(root: pathlib.Path):
    root = _absolute(root)
    root_fd = _open_root(root)
    parent_fd = descriptor = None
    try:
        parent_parts = (".harness",)
        parent_fd = _open_parent(root_fd, parent_parts, create=True)
        _assert_parent_identity(root_fd, parent_parts, parent_fd)
        metadata = _leaf_metadata(parent_fd, "write.lock")
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
        descriptor = os.open("write.lock", flags, 0o600, dir_fd=parent_fd)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("repository write lock must be a regular file")
        if metadata is not None:
            current = os.fstat(descriptor)
            if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
                raise ValueError("repository write lock changed while it was opened")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        try:
            _assert_parent_identity(root_fd, parent_parts, parent_fd)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise OSError("short repository write")
        offset += written


def _write_temporary(
    parent_fd: int,
    destination_name: str,
    content: bytes,
    prefix: str,
    mode: int,
) -> str:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    for _attempt in range(128):
        temporary = f".{destination_name}{prefix}{secrets.token_hex(8)}"
        try:
            descriptor = os.open(temporary, flags, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            continue
        try:
            _write_all(descriptor, content)
            os.fchmod(descriptor, mode)
            os.fsync(descriptor)
            return temporary
        except Exception:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            raise
        finally:
            os.close(descriptor)
    raise RuntimeError("could not allocate a unique repository temporary file")


def _replace(parent_fd: int, source: str, destination: str) -> None:
    try:
        os.replace(
            source,
            destination,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )
    except TypeError:
        raise RuntimeError("secure repository writes require dir_fd support for os.replace") from None


def _journal_parent(root_fd: int) -> int:
    return _open_parent(root_fd, (".harness",), create=True)


def _write_recovery_journal(root_fd: int, records: list[_Destination]) -> None:
    for record in records:
        relative = "/".join((*record.parent_parts, record.name))
        if relative not in RECOVERABLE_PATHS:
            raise RuntimeError(f"repository writer has no crash-recovery contract for {relative}")
        if len(record.original or b"") > 4 * 1024 * 1024:
            raise RuntimeError(f"repository writer cannot journal more than 4 MiB for {relative}")
    parent_fd = _journal_parent(root_fd)
    temporary = None
    try:
        _leaf_metadata(parent_fd, JOURNAL_NAME)
        payload = {
            "version": 1,
            "state": "prepared",
            "files": [
                {
                    "path": "/".join((*record.parent_parts, record.name)),
                    "existed": record.existed,
                    "mode": record.mode,
                    "originalBase64": base64.b64encode(record.original or b"").decode(),
                    "originalSha256": hashlib.sha256(record.original or b"").hexdigest(),
                }
                for record in records
            ],
        }
        content = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        temporary = _write_temporary(parent_fd, JOURNAL_NAME, content, ".prepare-", 0o600)
        _replace(parent_fd, temporary, JOURNAL_NAME)
        temporary = None
        _fsync_directory(parent_fd)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)


def _clear_recovery_journal(root_fd: int) -> None:
    parent_fd = _journal_parent(root_fd)
    try:
        try:
            os.unlink(JOURNAL_NAME, dir_fd=parent_fd)
        except FileNotFoundError:
            return
        _fsync_directory(parent_fd)
    finally:
        os.close(parent_fd)


def recover_pending_write(root: pathlib.Path) -> bool:
    """Restore a prepared transaction left by process/host failure, using only dirfd paths."""
    root = _absolute(root)
    root_fd = _open_root(root)
    journal_parent_fd = None
    try:
        try:
            journal_parent_fd = _journal_parent(root_fd)
            metadata = _leaf_metadata(journal_parent_fd, JOURNAL_NAME)
            if metadata is None:
                return False
            payload = json.loads(_read_leaf(journal_parent_fd, JOURNAL_NAME, metadata))
        except json.JSONDecodeError:
            raise RuntimeError("repository recovery journal is invalid JSON") from None
        if not isinstance(payload, dict) or payload.get("version") != 1 or payload.get("state") != "prepared":
            raise RuntimeError("repository recovery journal has an unsupported contract")
        files = payload.get("files")
        if not isinstance(files, list) or not files or len(files) > len(RECOVERABLE_PATHS):
            raise RuntimeError("repository recovery journal has no file records")
        seen_paths = set()
        restored_parents: list[int] = []
        try:
            for item in files:
                if not isinstance(item, dict) or set(item) != {
                    "path", "existed", "mode", "originalBase64", "originalSha256"
                }:
                    raise RuntimeError("repository recovery journal contains an invalid file record")
                relative = pathlib.PurePosixPath(item["path"])
                if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
                    raise RuntimeError("repository recovery journal contains an unsafe path")
                relative_text = relative.as_posix()
                if relative_text not in RECOVERABLE_PATHS or relative_text in seen_paths:
                    raise RuntimeError("repository recovery journal contains an unexpected or duplicate path")
                seen_paths.add(relative_text)
                original = base64.b64decode(item["originalBase64"], validate=True)
                if len(original) > 4 * 1024 * 1024:
                    raise RuntimeError("repository recovery journal content exceeds 4 MiB")
                if hashlib.sha256(original).hexdigest() != item["originalSha256"]:
                    raise RuntimeError("repository recovery journal content checksum mismatch")
                mode = item["mode"]
                if type(mode) is not int or not 0 <= mode <= 0o777:
                    raise RuntimeError("repository recovery journal contains an invalid mode")
                parent_fd = _open_parent(root_fd, tuple(relative.parts[:-1]), create=True)
                restored_parents.append(parent_fd)
                name = relative.parts[-1]
                if item["existed"] is True:
                    temporary = _write_temporary(parent_fd, name, original, ".recovery-", mode)
                    _replace(parent_fd, temporary, name)
                elif item["existed"] is False:
                    try:
                        os.unlink(name, dir_fd=parent_fd)
                    except FileNotFoundError:
                        pass
                else:
                    raise RuntimeError("repository recovery journal existed flag must be boolean")
                _fsync_directory(parent_fd)
            _clear_recovery_journal(root_fd)
            return True
        finally:
            for descriptor in restored_parents:
                os.close(descriptor)
    except (ValueError, TypeError, binascii.Error) as exc:
        raise RuntimeError(f"repository recovery journal is invalid: {exc}") from None
    finally:
        if journal_parent_fd is not None:
            os.close(journal_parent_fd)
        os.close(root_fd)


def atomic_write_files(root: pathlib.Path, files: dict[pathlib.Path, bytes]) -> None:
    root = _absolute(root)
    recover_pending_write(root)
    root_fd = _open_root(root)
    records: list[_Destination] = []
    replaced: list[_Destination] = []
    try:
        for raw_path, content in files.items():
            path = _absolute(pathlib.Path(raw_path))
            parts = _relative_parts(root, path)
            parent_fd = _open_parent(root_fd, parts[:-1], create=True)
            try:
                metadata = _leaf_metadata(parent_fd, parts[-1])
                original = None if metadata is None else _read_leaf(parent_fd, parts[-1], metadata)
                records.append(
                    _Destination(
                        path=path,
                        parent_parts=parts[:-1],
                        name=parts[-1],
                        parent_fd=parent_fd,
                        content=content,
                        existed=metadata is not None,
                        original=original,
                        mode=0o600 if metadata is None else stat.S_IMODE(metadata.st_mode),
                    )
                )
            except Exception:
                os.close(parent_fd)
                raise

        for record in records:
            _assert_parent_identity(root_fd, record.parent_parts, record.parent_fd)
            record.temporary = _write_temporary(
                record.parent_fd,
                record.name,
                record.content,
                ".harness-write-",
                record.mode,
            )

        _write_recovery_journal(root_fd, records)

        for record in records:
            _assert_parent_identity(root_fd, record.parent_parts, record.parent_fd)
            _replace(record.parent_fd, record.temporary, record.name)
            record.temporary = None
            replaced.append(record)
            _fsync_directory(record.parent_fd)
        _clear_recovery_journal(root_fd)
    except Exception:
        rollback_errors = []
        for record in reversed(replaced):
            rollback = None
            try:
                if record.existed:
                    rollback = _write_temporary(
                        record.parent_fd,
                        record.name,
                        record.original or b"",
                        ".harness-rollback-",
                        record.mode,
                    )
                    _replace(record.parent_fd, rollback, record.name)
                    rollback = None
                else:
                    try:
                        os.unlink(record.name, dir_fd=record.parent_fd)
                    except FileNotFoundError:
                        pass
                _fsync_directory(record.parent_fd)
            except Exception as exc:
                rollback_errors.append(f"{record.path}: {exc}")
            finally:
                if rollback is not None:
                    try:
                        os.unlink(rollback, dir_fd=record.parent_fd)
                    except FileNotFoundError:
                        pass
        if rollback_errors:
            raise RuntimeError(
                "repository write failed and rollback was incomplete: "
                + "; ".join(rollback_errors)
            ) from None
        _clear_recovery_journal(root_fd)
        raise
    finally:
        for record in records:
            if record.temporary is not None:
                try:
                    os.unlink(record.temporary, dir_fd=record.parent_fd)
                except FileNotFoundError:
                    pass
            os.close(record.parent_fd)
        os.close(root_fd)


def write_repository_files(root: pathlib.Path, files: dict[pathlib.Path, bytes]) -> None:
    with repository_write_lock(root):
        atomic_write_files(root, files)


def _config_bytes(config: dict) -> bytes:
    return (json.dumps(config, indent=2) + "\n").encode()


def write_config_cas_locked(
    root: pathlib.Path,
    config: dict,
    expected_sha256: str,
) -> None:
    destination = _absolute(root) / ".harness" / "config.json"
    current = read_repository_file(root, destination)
    assert current is not None
    if hashlib.sha256(current).hexdigest() != expected_sha256:
        raise RuntimeError("harness config changed since reconciliation started")
    atomic_write_files(root, {destination: _config_bytes(config)})


def write_config(root: pathlib.Path, config: dict) -> None:
    destination = _absolute(root) / ".harness" / "config.json"
    write_repository_files(root, {destination: _config_bytes(config)})


def _fsync_directory(directory_fd: int) -> None:
    os.fsync(directory_fd)
