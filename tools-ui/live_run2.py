"""Careful live run: paste question -> verify draft -> click Deep Research -> poll."""
import sys
import time
import uiautomation as auto
from dsh_gui import connect, find_doc

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
win = connect()
doc = find_doc(win)

def composer_pill(d):
    hit = None
    def walk(el, depth=0):
        nonlocal hit
        if hit is not None or depth > 60:
            return
        try:
            if el.ControlTypeName == "ButtonControl" and (el.Name or "").strip() in ("Deep Research", "Researching\u2026"):
                try:
                    nb = el.BoundingRectangle
                except Exception:
                    nb = None
                if nb and nb.bottom > 1000 and nb.left > 700:
                    hit = el
                    return
            for ch in el.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(d)
    return hit

def composer_edit(d):
    hits = []
    def walk(el, depth=0):
        if depth > 60:
            return
        try:
            if el.ControlTypeName == "EditControl" and "Message or run a task" in (el.Name or ""):
                try:
                    nb = el.BoundingRectangle
                except Exception:
                    nb = None
                if nb and nb.bottom > 1000:
                    hits.append(el)
            for ch in el.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(d)
    if hits:
        return max(hits, key=lambda e: e.BoundingRectangle.bottom)
    return None

def draft_value(edit):
    try:
        vp = edit.GetValuePattern()
        return vp.Value if vp else ""
    except Exception:
        return ""

pill = composer_pill(doc)
print("pill:", pill.Name if pill else None)
edit = composer_edit(doc)
if edit is None:
    print("no composer edit")
    sys.exit(4)
print("composer found; current draft:", repr(draft_value(edit)))

edit.Click()
time.sleep(0.8)
# Click again + use clipboard paste for reliability.
try:
    import subprocess
    subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value 'What is the capital of France?'"], check=True, capture_output=True)
except Exception as e:
    print("clipboard set failed", e)
time.sleep(0.3)
edit.Click()
time.sleep(0.5)
auto.SendKeys("^v")
time.sleep(1.2)
print("draft after paste:", repr(draft_value(edit)))

pill = composer_pill(find_doc(win))
if pill is None:
    print("pill missing")
    sys.exit(5)

# Guard: only run if a draft is present; otherwise expect the hint popover.
if not draft_value(edit).strip():
    print("draft empty -> clicking pill should show hint popover")
pill.Click()
time.sleep(1.5)

def band_text(d):
    texts = []
    def walk(el, depth=0):
        if depth > 50:
            return
        try:
            nm = (el.Name or "").strip()
            try:
                nb = el.BoundingRectangle
            except Exception:
                nb = None
            if nm and nb and nb.bottom > 800 and nb.top < 1450 and nb.left > 500:
                texts.append(nm)
            for ch in el.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(d)
    return " ".join(dict.fromkeys(texts))

deadline = time.time() + 200
state = ""
while time.time() < deadline:
    d = find_doc(win)
    state = band_text(d)
    pill2 = composer_pill(d)
    label = pill2.Name if pill2 else "?"
    if "Researching" in label or "sub-question" in state or "Research unavailable" in state or "Nothing to research" in state or "Copy report" in state:
        # keep watching until a terminal popover
        if "sub-question" in state or "Research unavailable" in state or "Nothing to research" in state or "Copy report" in state:
            break
    time.sleep(3)
    print("...", label, state[:120])

print("=== FINAL BAND ===")
print(state[:5000])
