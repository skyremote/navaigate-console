"""prompt-stack core: the manifest, the stack files and the cards.

Shared by hooks/inject.py (UserPromptSubmit), bin/prompt-stack (the /stack skill)
and the bb picker. Stdlib only.

Stack files live in ~/.claude/prompt-stack/ (override with PROMPT_STACK_HOME):
  projects/<key>.json  the project default, keyed by the repo root (or cwd)
  threads/<id>.json    a thread override: BB_THREAD_ID, else the Claude session id
A thread file, if present, replaces the project stack for that thread.
Inline +id / -id in a prompt changes that prompt only.
"""
import hashlib
import json
import os
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path(os.environ.get("PROMPT_STACK_HOME") or pathlib.Path.home() / ".claude" / "prompt-stack")
INLINE = re.compile(r"(?<!\S)([+-])([a-z][a-z0-9-]*)(?=[\s.,;:!?]|$)", re.I)


def manifest_path():
    return pathlib.Path(os.environ.get("PROMPT_STACK_MANIFEST") or ROOT / "stack.json")


def load_manifest():
    data = json.loads(manifest_path().read_text(encoding="utf-8"))
    by_name = {}
    for e in data["entries"]:
        for name in [e["id"], *e.get("aliases", [])]:
            by_name[name.lower()] = e
    return data, by_name


def project_root(cwd):
    p = pathlib.Path(cwd or os.getcwd()).resolve()
    for q in [p, *p.parents]:
        if (q / ".git").exists():
            return q
    return p


def project_file(cwd):
    root = project_root(cwd)
    return HOME / "projects" / (hashlib.sha1(str(root).encode()).hexdigest()[:12] + ".json"), root


def thread_id(session_id=None):
    return os.environ.get("BB_THREAD_ID") or session_id or os.environ.get("CLAUDE_CODE_SESSION_ID")


def thread_file(session_id=None):
    tid = thread_id(session_id)
    return (HOME / "threads" / (re.sub(r"[^A-Za-z0-9_.-]", "_", tid) + ".json")) if tid else None


def read_stack(path):
    try:
        return list(json.loads(path.read_text(encoding="utf-8")).get("stack", []))
    except (OSError, ValueError, AttributeError):
        return None


def write_stack(path, stack, **meta):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"stack": stack, **meta}, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def resolve(cwd=None, session_id=None):
    """Return (stack ids, scope) before any inline changes."""
    tf = thread_file(session_id)
    if tf:
        s = read_stack(tf)
        if s is not None:
            return s, "thread"
    pf, _ = project_file(cwd)
    s = read_stack(pf)
    return (s or []), ("project" if s is not None else "none")


def apply_inline(stack, prompt, by_name):
    """Apply +id / -id tokens that name a known entry. Unknown tokens are left alone."""
    stack = list(stack)
    for sign, name in INLINE.findall(prompt or ""):
        e = by_name.get(name.lower())
        if not e:
            continue
        if sign == "+" and e["id"] not in stack:
            stack.append(e["id"])
        elif sign == "-" and e["id"] in stack:
            stack.remove(e["id"])
    return stack


def render(stack, data, by_name, scope):
    """The text printed beside the prompt. Empty string when nothing is stacked."""
    warn = [s for s in stack if s.lower() not in by_name]
    entries = [by_name[s.lower()] for s in stack if s.lower() in by_name]
    out = []
    if warn:
        out.append("PROMPT STACK warning: unknown entries ignored: " + ", ".join(warn) + ". Run /prompt-stack:stack list.")
    if not entries:
        return "\n".join(out)
    out.append("PROMPT STACK (" + scope + "): " + ", ".join(e["id"] for e in entries))
    out.append("")
    for e in entries:
        out.append("[" + e["id"] + "] " + e["card"] + " Skill: " + e["skill"] + ".")
    fields = ["Objective"]
    for e in entries:
        fields += e.get("brief_fields", [])
    fields += ["Boundaries", "Skills to invoke"]
    order = data.get("brief_order", [])
    seen = []
    for f in sorted(dict.fromkeys(fields), key=lambda f: order.index(f) if f in order else len(order)):
        seen.append(f)
    out.append("")
    out.append("Before any other output, rewrite the request as a Brief block, one line per field: "
               + " / ".join(seen)
               + ". Fill each field from the cards above and the request. If a field cannot be filled, write 'unknown' and say what would settle it. Then invoke the listed skills and do the work.")
    return "\n".join(out)
