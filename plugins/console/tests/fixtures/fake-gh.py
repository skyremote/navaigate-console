#!/usr/bin/env python3
import json
import os
import re
import sys
import hashlib

state_path = os.environ["FAKE_GH_STATE"]
with open(state_path) as handle:
    state = json.load(handle)
args = sys.argv[1:]
stdin = sys.stdin.read() if "--input" in args else ""
body = json.loads(stdin) if stdin else {}
state["calls"].append({"args": args, "body": body})


def save():
    with open(state_path, "w") as handle:
        json.dump(state, handle)


def reply(value):
    save()
    print(json.dumps(value))
    sys.exit(0)


def fail(message, status):
    save()
    sys.stderr.write("gh: %s (HTTP %d)\n" % (message, status))
    sys.exit(1)


if args[0] != "api":
    fail("unsupported", 400)
method = "GET"
if "-X" in args:
    method = args[args.index("-X") + 1]
endpoint = [a for a in args[1:] if a.startswith("repos/")][0]
route = endpoint.split("?")[0]
query = endpoint.split("?")[1] if "?" in endpoint else ""
repo = state["repo"]
prefix = "repos/%s" % repo
if route == prefix:
    reply({"full_name": repo, "private": state["private"], "default_branch": state.get("defaultBranch", "main")})
m = re.fullmatch(prefix + r"/pulls/(\d+)", route)
if m and method == "GET":
    if int(m.group(1)) != state["pr"]:
        fail("Not Found", 404)
    reply({"number": state["pr"], "state": state.get("prState", "open"), "html_url": "https://github.com/%s/pull/%d" % (repo, state["pr"]), "head": {"ref": state.get("headRef", "fix/widgets")}, "base": {"ref": state.get("baseRef", "main")}})
m = re.fullmatch(prefix + r"/git/ref/heads/(.+)", route)
if m and method == "GET":
    head = state["refs"].get(m.group(1))
    if not head:
        fail("Not Found", 404)
    reply({"object": {"sha": head}})
m = re.fullmatch(prefix + r"/git/commits/(\w+)", route)
if m and method == "GET":
    commit = state["commits"].get(m.group(1))
    if not commit:
        fail("Not Found", 404)
    reply({"sha": m.group(1), "tree": {"sha": commit["tree"]}})
if route == prefix + "/git/blobs" and method == "POST":
    raw = __import__("base64").b64decode(body["content"])
    sha = hashlib.sha1(raw).hexdigest()
    state["blobs"][sha] = len(raw)
    reply({"sha": sha})
if route == prefix + "/git/trees" and method == "POST":
    tree_sha = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
    state["trees"][tree_sha] = {entry["path"]: entry["sha"] for entry in body["tree"]}
    reply({"sha": tree_sha})
if route == prefix + "/git/commits" and method == "POST":
    commit_sha = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
    state["commits"][commit_sha] = {"tree": body["tree"], "parents": body.get("parents", [])}
    reply({"sha": commit_sha})
if route == prefix + "/git/refs" and method == "POST":
    state["refs"][body["ref"].replace("refs/heads/", "")] = body["sha"]
    reply({"ref": body["ref"], "object": {"sha": body["sha"]}})
m = re.fullmatch(prefix + r"/git/refs/heads/(.+)", route)
if m and method == "PATCH":
    if body.get("force"):
        fail("force not allowed", 422)
    state["refs"][m.group(1)] = body["sha"]
    reply({"object": {"sha": body["sha"]}})
m = re.fullmatch(prefix + r"/contents/(.+)", route)
if m and method == "GET":
    ref = query.replace("ref=", "")
    path = __import__("urllib.parse").parse.unquote(m.group(1))
    commit = state["commits"].get(ref)
    tree = state["trees"].get(commit["tree"]) if commit else None
    sha = tree.get(path) if tree else None
    if not sha:
        fail("Not Found", 404)
    size = state["blobs"][sha]
    if state.get("lieAboutSize"):
        size += 1
    reply({"sha": sha, "size": size, "path": path})
m = re.fullmatch(prefix + r"/issues/(\d+)/comments", route)
if m and method == "POST":
    if state.get("commentFails"):
        fail("Resource not accessible", 403)
    cid = len(state["comments"]) + 1
    state["comments"][str(cid)] = body["body"]
    reply({"id": cid, "html_url": "https://github.com/%s/pull/%d#issuecomment-%d" % (repo, state["pr"], 9000 + cid), "body": body["body"]})
m = re.fullmatch(prefix + r"/issues/comments/(\d+)", route)
if m and method == "GET":
    text = state["comments"].get(m.group(1))
    if text is None:
        fail("Not Found", 404)
    reply({"id": int(m.group(1)), "body": text})
fail("unhandled %s %s" % (method, route), 404)
