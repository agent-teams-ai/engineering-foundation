// Fixed collector code; flags are JSON stdin, never interpolated remote shell text.
export const reviewCollector = String.raw`
import json, os, pathlib, re, stat, sys
q = json.load(sys.stdin)
job = q["job"]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", job): raise ValueError("job identifier")
registry, jobs, workspaces = [pathlib.Path(q[k]) for k in ["registry", "jobs", "workspaces"]]
root = jobs / job
workspace = workspaces / job
def read(p):
    if p.resolve() != p or p.is_symlink(): raise ValueError("symlink custody file")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: raise ValueError("unprotected custody file")
        b = f.read(8 * 1024 * 1024 + 1)
    if len(b) > 8 * 1024 * 1024: raise ValueError("bounded review read exceeded")
    return b
def load(p): return json.loads(read(p))
m = load(registry / job / "job.json")
if m["jobRootDir"] != str(root) or m["promptPath"] != str(root / "prompt.md") or m["workspacePath"] != str(workspace): raise ValueError("job namespace")
progress = load(root / (job + ".progress.json"))
if progress.get("taskId") != job or progress.get("status") != "completed": raise ValueError("review job not terminal")
r = load(root / (job + ".latest-result.json"))
result = {"manifest": {k: m.get(k) for k in ["jobId", "taskId", "jobRootDir", "promptPath", "workspacePath", "model", "reasoningEffort", "serviceTier"]},
 "progress": {k: progress.get(k) for k in ["taskId", "status", "updatedAt"]},
 "receipt": {k: r.get(k) for k in ["status", "provider", "taskId", "runId", "blockers", "changedFiles", "evidence"]},
 "prompt": read(root / "prompt.md").decode("utf-8"), "machineId": pathlib.Path("/etc/machine-id").read_text().strip()}
result["receipt"]["details"] = {"baseCommit": r.get("details", {}).get("baseCommit")}
if load(root / (job + ".progress.json")) != progress: raise ValueError("review progress changed during collection")
print(json.dumps(result))
`;
// Runs unprivileged. Candidate Git configuration, index and hooks are never executed.
export const reviewTreeInspector = String.raw`
import hashlib, json, os, pathlib, stat, sys
q = json.load(sys.stdin)
workspace = pathlib.Path(q["workspace"])
if workspace.resolve() != workspace or not workspace.is_dir(): raise ValueError("workspace namespace")
expected = {}
for entry in q["entries"]:
    name, mode, digest = entry["path"], entry["mode"], entry["sha"]
    if entry["type"] == "tree": continue
    parts = pathlib.PurePosixPath(name).parts
    if not parts or name != "/".join(parts) or any(p in [".", "..", ".git"] for p in parts) or name.startswith("/"): raise ValueError("tree path")
    if entry["type"] != "blob" or mode not in ["100644", "100755", "120000"] or name in expected: raise ValueError("unsupported tree entry")
    expected[name] = (mode, digest)
if not expected or len(expected) > 20000: raise ValueError("bounded tree inventory")
seen, total = set(), 0
def traversal_error(error): raise error
def identity(info): return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)
for root, dirs, files in os.walk(workspace, followlinks=False, onerror=traversal_error):
    if pathlib.Path(root) == workspace and ".git" in dirs: dirs.remove(".git")
    for name in list(dirs):
        path = pathlib.Path(root) / name
        if path.is_symlink(): dirs.remove(name); files.append(name)
    for name in files:
        path = pathlib.Path(root) / name
        rel = path.relative_to(workspace).as_posix()
        if rel == ".git": continue
        if rel not in expected: raise ValueError("unexpected review file: " + rel)
        mode, digest = expected[rel]
        before = path.lstat()
        if mode == "120000":
            if not stat.S_ISLNK(before.st_mode): raise ValueError("symlink mode")
            data = os.fsencode(os.readlink(path))
        else:
            if not stat.S_ISREG(before.st_mode) or bool(before.st_mode & 0o111) != (mode == "100755"): raise ValueError("file mode")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as f:
                opened = os.fstat(f.fileno())
                if identity(opened) != identity(before): raise ValueError("source descriptor mismatch")
                data = f.read(8 * 1024 * 1024 + 1)
                if identity(os.fstat(f.fileno())) != identity(opened): raise ValueError("source descriptor changed during read")
        total += len(data)
        if len(data) > 8 * 1024 * 1024 or total > 128 * 1024 * 1024: raise ValueError("bounded tree bytes")
        after = path.lstat()
        if identity(before) != identity(after): raise ValueError("source changed during read")
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != digest: raise ValueError("source blob mismatch: " + rel)
        seen.add(rel)
if seen != set(expected): raise ValueError("missing review files")
print(json.dumps({"sourceTreeVerified": True}))
`;
