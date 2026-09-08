"""Full text dump of the DSH document + header breadcrumb + pills/popovers."""
import sys
import time
import uiautomation as auto
from dsh_gui import connect, find_doc

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
win = connect()
doc = find_doc(win)
if doc is None:
    print("no doc")
    sys.exit(3)

lines = []
def walk(el, depth=0):
    if depth > 45:
        return
    try:
        nm = (el.Name or "").strip()
        t = el.ControlTypeName
        try:
            nb = el.BoundingRectangle
            rect = f"[{nb.left},{nb.top},{nb.right},{nb.bottom}]"
        except Exception:
            rect = ""
        if nm:
            lines.append(f"{'  '*min(depth,6)}{t} | {nm[:160]} {rect}")
        for ch in el.GetChildren():
            walk(ch, depth + 1)
    except Exception:
        pass

walk(doc)
text = "\n".join(lines)
print(text[:8000])
