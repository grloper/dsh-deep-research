"""Live E2E: fresh session -> type question -> click Deep Research -> read report."""
import sys
import time
import uiautomation as auto
from dsh_gui import connect, find_doc, find_ctrl

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

win = connect()

# 1. Fresh reload to be safe after server restart.
win.SendKeys("{F5}")
time.sleep(10)
doc = find_doc(win)
if doc is None:
    print("no DSH doc after reload")
    sys.exit(3)

def composer_pill(doc):
    """The real composer pill: ButtonControl named exactly 'Deep Research' in the bottom band."""
    hit = None
    def walk(el, depth=0):
        nonlocal hit
        if hit is not None or depth > 60:
            return
        try:
            if el.ControlTypeName == "ButtonControl" and (el.Name or "").strip() == "Deep Research":
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
    walk(doc)
    return hit

pill = composer_pill(doc)
if pill is None:
    print("composer Deep Research pill not found")
    sys.exit(4)
print("pill found:", pill.Name)

# 2. Open a fresh session via the sidebar 'New Session' card.
newbtn = find_ctrl(doc, "ButtonControl", "New Session")
if newbtn is None:
    # some builds label the top-left button 'New session'
    newbtn = find_ctrl(doc, "ButtonControl", "New session")
if newbtn is None:
    print("new-session control not found")
    sys.exit(5)
newbtn.Click()
time.sleep(3)
doc = find_doc(win)  # refresh after navigation

# 3. Type the research question into the composer.
edit = find_ctrl(doc, "EditControl", "Message or run a task")
if edit is None:
    edit = find_ctrl(doc, "EditControl", "Message")
if edit is None:
    print("composer edit not found in fresh session")
    sys.exit(6)
edit.Click()
time.sleep(0.8)
QUESTION = "What is the capital of France?"
auto.SendKeys(QUESTION)
time.sleep(1.0)

# Confirm the draft holds the text.
val = ""
try:
    vp = edit.GetValuePattern()
    if vp:
        val = vp.Value
except Exception:
    pass
print("draft:", repr(val))

# 4. Click the Deep Research pill (it now reads the draft and runs the engine).
pill = composer_pill(find_doc(win))
if pill is None:
    print("pill lost after new session")
    sys.exit(7)
print("clicking Deep Research with a non-empty draft")
pill.Click()

# 5. Poll for the outcome popover (running can take tens of seconds).
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
            if nm and nb and nb.bottom > 900 and nb.top < 1400 and nb.left > 600:
                texts.append(nm)
            for ch in el.GetChildren():
                walk(ch, depth + 1)
        except Exception:
            pass
    walk(d)
    return " ".join(dict.fromkeys(texts))

deadline = time.time() + 180
state = ""
while time.time() < deadline:
    state = band_text(find_doc(win))
    if "Research unavailable" in state or "Nothing to research" in state or "Copy report" in state or "sub-question" in state:
        break
    time.sleep(3)

print("=== outcome band text ===")
print(state[:4000])
